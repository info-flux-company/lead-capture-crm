/**
 * ============================================================================
 * Supabase Realtime & Web Audio Notification Service
 * ============================================================================
 * Subscribes to live PostgreSQL INSERT events on `public.leads` scoped by the
 * user's `workspace_id`, and synthesizes a clean executive notification chime
 * using the browser's native Web Audio API (zero external audio files).
 * ============================================================================
 */

import APP_CONFIG from '../config.js';
import supabaseManager from '../supabaseClient.js';

const MUTE_STORAGE_KEY = 'crm-realtime-muted';

/**
 * Manages live lead notifications and synthesized Web Audio sound alerts.
 */
export class RealtimeService {
    /** @type {import('@supabase/supabase-js').SupabaseClient | null} */
    #injectedClient;

    /** @type {any | null} */
    #channel = null;

    /** @type {string | null} */
    #activeWorkspaceId = null;

    /** @type {AudioContext | null} */
    #audioContext = null;

    /** @type {boolean} */
    #muted = false;

    /**
     * @param {import('@supabase/supabase-js').SupabaseClient | null} [supabaseClient]
     */
    constructor(supabaseClient = null) {
        this.#injectedClient = supabaseClient;
        this.#muted = this.#loadMutePreference();
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
     * Reads saved mute preference from localStorage with safe fallback.
     * @returns {boolean}
     */
    #loadMutePreference() {
        const defaultMuted = !APP_CONFIG.dashboard.soundEnabledByDefault;
        try {
            if (typeof localStorage === 'undefined') {
                return defaultMuted;
            }
            const stored = localStorage.getItem(MUTE_STORAGE_KEY);
            if (stored === 'true') return true;
            if (stored === 'false') return false;
            return defaultMuted;
        } catch {
            return defaultMuted;
        }
    }

    /**
     * Persists mute preference to localStorage safely.
     * @param {boolean} muted
     */
    #saveMutePreference(muted) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false');
            }
        } catch {
            // Ignore storage quota or private mode errors
        }
    }

    /**
     * Returns whether notification sound alerts are currently muted.
     * @returns {boolean}
     */
    isMuted() {
        return this.#muted;
    }

    /**
     * Updates notification mute state and persists preference.
     * @param {boolean} muted
     * @returns {boolean}
     */
    setMuted(muted) {
        this.#muted = Boolean(muted);
        this.#saveMutePreference(this.#muted);
        return this.#muted;
    }

    /**
     * Toggles mute state and returns the updated mute flag.
     * @returns {boolean}
     */
    toggleMute() {
        return this.setMuted(!this.#muted);
    }

    /**
     * Lazily initializes or resumes the browser Web Audio API context.
     * Safe to invoke from user interactions (e.g., login click or unmute toggle).
     * @returns {AudioContext | null}
     */
    unlockAudio() {
        const ctx = this.#ensureAudioContext();
        if (!ctx) {
            return null;
        }

        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            ctx.resume().catch(() => {});
        }
        return ctx;
    }

    /**
     * Creates the shared AudioContext if supported in the current runtime.
     * @returns {AudioContext | null}
     */
    #ensureAudioContext() {
        if (this.#audioContext) {
            return this.#audioContext;
        }

        const AudioCtx =
            typeof globalThis !== 'undefined'
                ? globalThis.AudioContext || globalThis.webkitAudioContext
                : null;
        if (typeof AudioCtx !== 'function') {
            return null;
        }

        try {
            this.#audioContext = new AudioCtx();
            return this.#audioContext;
        } catch {
            return null;
        }
    }

    /**
     * Plays a crisp, pleasant dual-note notification chime using Web Audio API.
     * Zero external .mp3 dependencies; ignores autoplay restrictions gracefully.
     * @param {boolean} [force]
     * @returns {boolean}
     */
    playNotificationChime(force = false) {
        if (this.#muted && !force) {
            return false;
        }

        const ctx = this.unlockAudio();
        if (!ctx) {
            return false;
        }

        try {
            const now = ctx.currentTime;
            // Dual-note executive chime: A5 (880 Hz) -> E6 (1318.51 Hz)
            this.#scheduleTone(ctx, {
                frequency: 880,
                startTime: now,
                duration: 0.22,
                peakGain: 0.14
            });
            this.#scheduleTone(ctx, {
                frequency: 1318.51,
                startTime: now + 0.11,
                duration: 0.34,
                peakGain: 0.16
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Schedules a single smooth sine tone envelope without audible clicks.
     * @param {AudioContext} ctx
     * @param {{ frequency: number, startTime: number, duration: number, peakGain: number }} params
     */
    #scheduleTone(ctx, { frequency, startTime, duration, peakGain }) {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startTime);

        gainNode.gain.setValueAtTime(0.0001, startTime);
        gainNode.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.018);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.start(startTime);
        oscillator.stop(startTime + duration + 0.02);
    }

    /**
     * Subscribes to live INSERT events on `public.leads` for the active workspace.
     * @param {string} workspaceId
     * @param {{ onNewLead?: (lead: Record<string, any>) => void, onStatusChange?: (status: string) => void }} [handlers]
     * @returns {Promise<void>}
     */
    async subscribe(workspaceId, { onNewLead, onStatusChange } = {}) {
        if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
            throw new Error('معرف مساحة العمل مطلوب لتفعيل التنبيهات الفورية.');
        }

        const cleanWorkspaceId = workspaceId.trim();
        await this.unsubscribe();

        const client = this.#getClient();
        const channelName = `leads-realtime-${cleanWorkspaceId}`;

        const channel = client
            .channel(channelName)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'leads',
                    filter: `workspace_id=eq.${cleanWorkspaceId}`
                },
                (payload) => {
                    const newLead = payload?.new;
                    if (!newLead || newLead.workspace_id !== cleanWorkspaceId) {
                        return;
                    }

                    this.playNotificationChime();
                    if (typeof onNewLead === 'function') {
                        onNewLead(newLead);
                    }
                }
            )
            .subscribe((status) => {
                if (typeof onStatusChange === 'function') {
                    onStatusChange(status);
                }
            });

        this.#channel = channel;
        this.#activeWorkspaceId = cleanWorkspaceId;
    }

    /**
     * Removes any active Supabase Realtime channel subscription cleanly.
     * @returns {Promise<void>}
     */
    async unsubscribe() {
        if (!this.#channel) {
            this.#activeWorkspaceId = null;
            return;
        }

        const channelToRemove = this.#channel;
        this.#channel = null;
        this.#activeWorkspaceId = null;

        try {
            const client = this.#getClient();
            if (typeof client.removeChannel === 'function') {
                await client.removeChannel(channelToRemove);
            } else if (typeof channelToRemove.unsubscribe === 'function') {
                await channelToRemove.unsubscribe();
            }
        } catch {
            // Ignore cleanup errors during teardown
        }
    }

    /**
     * Indicates whether a Realtime subscription is currently active.
     * @returns {boolean}
     */
    isSubscribed() {
        return Boolean(this.#channel);
    }

    /**
     * Returns the workspace ID currently subscribed to Realtime updates.
     * @returns {string | null}
     */
    getActiveWorkspaceId() {
        return this.#activeWorkspaceId;
    }
}

export default RealtimeService;
