/**
 * ============================================================================
 * Authentication & Workspace Authorization Service
 * ============================================================================
 * Manages Supabase Auth sign-in/sign-out, session verification, and tenant
 * workspace role resolution ('owner' | 'sales').
 * Closed registration: NO public sign-up flow is exposed.
 * ============================================================================
 */

import APP_CONFIG from '../config.js';
import supabaseManager from '../supabaseClient.js';

const VALID_ROLES = new Set(['owner', 'sales']);

/**
 * Handles authentication, workspace membership resolution, and session events.
 */
export class AuthService {
    /** @type {import('@supabase/supabase-js').SupabaseClient | null} */
    #injectedClient;

    /** @type {import('@supabase/supabase-js').User | null} */
    #currentUser = null;

    /** @type {{ workspaceId: string, workspaceName: string, role: 'owner' | 'sales' } | null} */
    #workspaceContext = null;

    /** @type {{ unsubscribe: () => void } | null} */
    #authSubscription = null;

    /**
     * @param {import('@supabase/supabase-js').SupabaseClient | null} [supabaseClient]
     */
    constructor(supabaseClient = null) {
        this.#injectedClient = supabaseClient;
    }

    /**
     * Resolves the active Supabase client lazily.
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    #getClient() {
        if (this.#injectedClient) {
            return this.#injectedClient;
        }
        return supabaseManager.getClient();
    }

    /**
     * Checks whether Supabase configuration is ready for authentication requests.
     * @returns {boolean}
     */
    isBackendConfigured() {
        return Boolean(this.#injectedClient || supabaseManager.isConfigured());
    }

    /**
     * Returns any configuration error preventing client initialization.
     * @returns {string | null}
     */
    getConfigurationError() {
        return this.#injectedClient ? null : supabaseManager.getConfigError();
    }

    /**
     * Signs in a provisioned user and verifies active workspace membership.
     * @param {string} email
     * @param {string} password
     * @returns {Promise<{ user: any, session: any, workspaceId: string, workspaceName: string, role: 'owner' | 'sales' }>}
     */
    async signIn(email, password) {
        const normalizedEmail = typeof email === 'string' ? email.trim() : '';
        const rawPassword = typeof password === 'string' ? password : '';

        if (!normalizedEmail || !normalizedEmail.includes('@')) {
            throw new Error('يرجى إدخال بريد إلكتروني صحيح.');
        }

        if (!rawPassword) {
            throw new Error('يرجى إدخال كلمة المرور.');
        }

        const client = this.#getClient();
        let authResult;
        try {
            authResult = await client.auth.signInWithPassword({
                email: normalizedEmail,
                password: rawPassword
            });
        } catch (err) {
            throw new Error(this.#mapAuthError(err));
        }

        if (authResult?.error) {
            throw new Error(this.#mapAuthError(authResult.error));
        }

        const user = authResult?.data?.user;
        const session = authResult?.data?.session;
        if (!user?.id) {
            throw new Error('تعذر التحقق من بيانات الحساب. يرجى المحاولة مرة أخرى.');
        }

        const context = await this.fetchUserWorkspaceContext(user.id);
        if (!context) {
            await this.#safeSignOut(client);
            this.#clearState();
            throw new Error(
                'هذا الحساب غير مرتبط بأي مساحة عمل نشطة. يرجى التواصل مع مدير النظام.'
            );
        }

        this.#currentUser = user;
        this.#workspaceContext = context;

        return {
            user,
            session,
            ...context
        };
    }

    /**
     * Signs out the active user and clears local workspace session state.
     * @returns {Promise<void>}
     */
    async signOut() {
        this.#clearState();
        if (!this.isBackendConfigured()) {
            return;
        }
        const client = this.#getClient();
        await this.#safeSignOut(client);
    }

    /**
     * Checks the current browser session and resolves its workspace & role context.
     * Signs out orphaned accounts lacking a valid workspace_members assignment.
     * @returns {Promise<{ user: any, session: any, workspaceId: string, workspaceName: string, role: 'owner' | 'sales' } | null>}
     */
    async getSessionContext() {
        if (!this.isBackendConfigured()) {
            this.#clearState();
            return null;
        }

        const client = this.#getClient();
        const { data, error } = await client.auth.getSession();
        if (error || !data?.session?.user?.id) {
            this.#clearState();
            return null;
        }

        const session = data.session;
        const user = session.user;

        const context = await this.fetchUserWorkspaceContext(user.id);
        if (!context) {
            await this.#safeSignOut(client);
            this.#clearState();
            return null;
        }

        this.#currentUser = user;
        this.#workspaceContext = context;

        return {
            user,
            session,
            ...context
        };
    }

    /**
     * Fetches the user's primary workspace ID, workspace name, and assigned role.
     * @param {string} userId
     * @returns {Promise<{ workspaceId: string, workspaceName: string, role: 'owner' | 'sales' } | null>}
     */
    async fetchUserWorkspaceContext(userId) {
        if (!userId || typeof userId !== 'string') {
            return null;
        }

        const client = this.#getClient();
        const { data, error } = await client
            .from('workspace_members')
            .select('workspace_id, role, workspaces ( id, name )')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('[AuthService] Failed to fetch workspace membership:', error.message);
            throw new Error('تعذر التحقق من صلاحيات مساحة العمل.');
        }

        if (!data || !data.workspace_id || !VALID_ROLES.has(data.role)) {
            return null;
        }

        const joinedWorkspace = Array.isArray(data.workspaces)
            ? data.workspaces[0]
            : data.workspaces;

        return {
            workspaceId: data.workspace_id,
            workspaceName: joinedWorkspace?.name || APP_CONFIG.branding.brandName,
            role: data.role
        };
    }

    /**
     * Subscribes to Supabase auth state transitions without running blocking DB
     * queries synchronously inside the auth callback (prevents v2 lock deadlocks).
     * @param {(payload: { event: string, authenticated: boolean, context: any }) => void} callback
     * @returns {() => void}
     */
    onAuthStateChange(callback) {
        if (typeof callback !== 'function') {
            throw new Error('onAuthStateChange requires a callback function.');
        }

        this.#unsubscribeListener();

        if (!this.isBackendConfigured()) {
            return () => {};
        }

        let active = true;
        const client = this.#getClient();
        const { data } = client.auth.onAuthStateChange((event, session) => {
            if (!active) {
                return;
            }

            if (event === 'SIGNED_OUT' || !session?.user?.id) {
                this.#clearState();
                callback({
                    event,
                    authenticated: false,
                    context: null
                });
                return;
            }

            // Defer DB lookup outside Supabase's synchronous auth lock
            setTimeout(async () => {
                if (!active) {
                    return;
                }
                try {
                    const context = await this.fetchUserWorkspaceContext(session.user.id);
                    if (!active) {
                        return;
                    }
                    if (!context) {
                        await this.#safeSignOut(client);
                        this.#clearState();
                        callback({
                            event,
                            authenticated: false,
                            context: null
                        });
                        return;
                    }

                    this.#currentUser = session.user;
                    this.#workspaceContext = context;
                    callback({
                        event,
                        authenticated: true,
                        context: {
                            user: session.user,
                            session,
                            ...context
                        }
                    });
                } catch {
                    if (!active) {
                        return;
                    }
                    this.#clearState();
                    callback({
                        event,
                        authenticated: false,
                        context: null
                    });
                }
            }, 0);
        });

        this.#authSubscription = data?.subscription || null;

        return () => {
            active = false;
            this.#unsubscribeListener();
        };
    }

    /**
     * @returns {import('@supabase/supabase-js').User | null}
     */
    getCurrentUser() {
        return this.#currentUser;
    }

    /**
     * @returns {{ workspaceId: string, workspaceName: string, role: 'owner' | 'sales' } | null}
     */
    getWorkspaceContext() {
        return this.#workspaceContext;
    }

    /**
     * @returns {string | null}
     */
    getWorkspaceId() {
        return this.#workspaceContext?.workspaceId || null;
    }

    /**
     * @returns {'owner' | 'sales' | null}
     */
    getRole() {
        return this.#workspaceContext?.role || null;
    }

    /**
     * @returns {boolean}
     */
    isOwner() {
        return this.#workspaceContext?.role === 'owner';
    }

    /**
     * @returns {boolean}
     */
    isAuthenticated() {
        return Boolean(this.#currentUser && this.#workspaceContext);
    }

    /**
     * Clears cached user and workspace context.
     */
    #clearState() {
        this.#currentUser = null;
        this.#workspaceContext = null;
    }

    /**
     * Unsubscribes any active auth listener cleanly.
     */
    #unsubscribeListener() {
        if (this.#authSubscription && typeof this.#authSubscription.unsubscribe === 'function') {
            this.#authSubscription.unsubscribe();
        }
        this.#authSubscription = null;
    }

    /**
     * Safely triggers Supabase signOut without throwing secondary cleanup errors.
     * @param {import('@supabase/supabase-js').SupabaseClient} client
     */
    async #safeSignOut(client) {
        try {
            await client.auth.signOut();
        } catch {
            // Ignore signOut cleanup failures
        }
    }

    /**
     * Maps Supabase Auth errors into clear Arabic user-facing messages.
     * @param {any} error
     * @returns {string}
     */
    #mapAuthError(error) {
        const message = String(error?.message || '').toLowerCase();
        const status = Number(error?.status || 0);

        if (
            message.includes('invalid login credentials') ||
            message.includes('invalid_credentials')
        ) {
            return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
        }
        if (message.includes('email not confirmed')) {
            return 'الحساب غير مفعّل بعد. يرجى التواصل مع مدير النظام.';
        }
        if (status === 429 || message.includes('too many requests') || message.includes('rate limit')) {
            return 'محاولات تسجيل دخول متكررة، يرجى المحاولة بعد قليل.';
        }
        if (
            message.includes('fetch') ||
            message.includes('network') ||
            message.includes('failed to fetch')
        ) {
            return 'تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت.';
        }

        return 'حدث خطأ أثناء تسجيل الدخول. يرجى المحاولة مرة أخرى.';
    }
}

export default AuthService;
