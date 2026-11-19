# 🚀 نظام التقاط وتحليل العملاء B2B ولوحة التحكم الذكية (Arabic RTL)
### Reusable B2B Lead Capture & Analytics Mini-CRM Dashboard

نظام متكامل ومفتوح المصدر وخالي من تكاليف الاستضافة (Zero-Cost Ecosystem)، مصمم وفق أعلى معايير أمان التطبيقات وحماية البيانات للشركات ووكالات التسويق الرقمي B2B، بواجهة عربية تنفيذية فاخرة (RTL).

---

## 🌟 مميزات النظام الأساسية

1. **واجهة تحكم تنفيذية فاخرة (Executive Dashboard):**
   - تصميم عربي بالكامل (`dir="rtl"`) مع خط **IBM Plex Sans Arabic**.
   - أرقام وجداول متسقة باستخدام `tabular-nums`.
   - بطاقات إحصائية للمؤشرات الرئيسية (إجمالي الزيارات، عدد العملاء، نسبة التحويل، العملاء الجدد).
   - رسوم بيانية تفاعلية (Chart.js) لساعات الذروة، وأعلى المدن، ومصادر الحملات (UTM Sources).
   - جدول ذكي يتحول تلقائياً إلى بطاقات تفاعلية أنيقة على الهواتف الذكية.
   - أزرار اتصال ومراسلة مباشرة عبر واتساب بنقرة واحدة برسالة مخصصة مسبقاً.

2. **تحديث لحظي بدون إعادة تحميل (Realtime Engine):**
   - استماع لحظي لجدول العملاء عبر Supabase Realtime مع فلترة مخصصة لعزل مساحات العمل.
   - رنة إشعار صوتية احترافية ثنائية النغمة باستخدام Web Audio API (بدون أي ملفات صوتية خارجية).
   - وميض بصري أزرق ناعم للسطر الجديد مع إشعارات منبثقة (Toast).

3. **جدار أمان متقدم ومنع سرقة البيانات (Anti-Data-Theft):**
   - **فصل صلاحيات صارم (Owner vs Sales):** موظف المبيعات لا يمكنه حذف العملاء أو تصديرهم، ولا يمكنه تعديل أسماء أو أرقام الهواتف (محمية بـ PostgreSQL Trigger على مستوى السيرفر).
   - زر تصدير Excel/CSV مخصص فقط للمدير (Owner) ومحصن ضد هجمات CSV Injection (CWE-1236) بترميز UTF-8 مع BOM لفتح الأسماء العربية في Excel بدون تشويه.
   - سياسات أمان صارمة على مستوى السطور (Row Level Security - RLS).
   - تحصين كامل ضد هجمات XSS وحقن الاستعلامات SQL Injection.

4. **تتبع جغرافي ذكي ونقاط نهاية سحابية (Cloudflare Pages Functions):**
   - نقطة نهاية لتسجيل الزيارات `/api/track-view` تستخرج الدولة والمدينة ونوع الجهاز مجاناً عبر شبكة Cloudflare Edge.
   - نقطة نهاية لالتقاط العملاء `/api/submit-lead` تفحص أرقام الهواتف، وتطبق معدل الطلبات (Rate Limiting)، وتتضمن فخ البوتات (Honeypot) لصد السبام.

5. **قابلية إعادة الاستخدام والتخصيص (White-Label Architecture):**
   - تخصيص كامل للعلامة التجارية، الشعار، مفاتيح الربط، كود الدولة، وقالب رسائل الواتساب من ملف إعدادات واحد فقط: `js/config.js`.

---

## 📁 هيكلية المشروع (Project Architecture)

```text
/
├── index.html                    # واجهة الدخول ولوحة التحكم الرئيسية (RTL SPA)
├── landing-demo.html             # صفحة هبوط نموذجية جاهزة ومربوطة بالنظام وفخ البوت
├── .gitignore                    # ملف حماية واستثناء المفاتيح السرية
├── css/
│   └── custom.css                # أنماط الجدول التجاوبي، شريط التمرير، وخط الأرقام
├── js/
│   ├── config.js                 # المصدر الوحيد لإعدادات العلامة التجارية وقاعدة البيانات
│   ├── supabaseClient.js         # عميل Supabase Singleton محمي ضد تسريب مفاتيح السيرفر
│   ├── utils/
│   │   └── SecurityUtils.js      # معالجة النصوص، تنظيف الهواتف، والتصدير الآمن لـ CSV
│   ├── services/
│   │   ├── AuthService.js        # إدارة الجلسات والمصادقة وفصل مساحات العمل
│   │   ├── DataService.js        # استعلامات وتحديثات قاعدة البيانات المحمية
│   │   └── RealtimeService.js    # استقبال التحديثات الفورية وتشغيل نغمة التنبيه
│   ├── ui/
│   │   ├── ChartManager.js       # إدارة الرسوم البيانية لساعات الذروة والمدن
│   │   ├── TableManager.js       # إدارة وتحديث جدول العملاء بشكل آمن
│   │   └── ToastManager.js       # نظام الإشعارات العائمة
│   └── app.js                    # المنسق العام لتشغيل التطبيق والواجهات
├── functions/
│   └── api/
│       ├── track-view.js         # دالة السيرفر لتتبع الزيارات عبر Cloudflare Edge
│       └── submit-lead.js        # دالة السيرفر للتحقق والتقاط بيانات العميل
└── database/
    └── schema.sql                # الجداول، الفهارس، التريجرز، وسياسات RLS الكاملة
```

---

## 🛠️ خطوات التثبيت والتشغيل السريع

### 1. إعداد قاعدة البيانات (Supabase)
1. أنشئ مشروعاً جديداً على [Supabase](https://supabase.com).
2. افتح **SQL Editor** وانسخ محتوى الملف `database/schema.sql` ونفّذه بالكامل.
3. تأكد من تفعيل الـ Realtime لجدول `leads` بتنفيذ:
   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
   ```
4. أنشئ حساب المدير من تبويب **Authentication** -> **Users** ثم عيّنه كـ Owner في جدول `workspace_members`.

### 2. ضبط ملف الإعدادات
افتح الملف `js/config.js` وضع رابط مشروعك والمفتاح العام:
```javascript
export const APP_CONFIG = Object.freeze({
  supabase: Object.freeze({
    url: 'https://YOUR_PROJECT_ID.supabase.co',
    anonKey: 'YOUR_SUPABASE_ANON_KEY',
  }),
  branding: Object.freeze({
    companyName: 'شركتك أو اسم العميل',
    // ...
  })
});
```

### 3. النشر على Cloudflare Pages (مجاناً)
1. ارفع المشروع إلى **GitHub**.
2. من لوحة تحكم **Cloudflare** -> اختر **Workers & Pages** -> **Create application** -> **Pages**.
3. اربط مستودع GitHub بدون أي أوامر بناء (Build Command: فارغ، Output Directory: `.`).
4. أضف المتغيرات البيئية (Environment Variables):
   - `SUPABASE_URL`: رابط مشروعك في Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: المفتاح السري (`service_role`) لحفظ الليدات والزيارات من السيرفر.

---

## 📄 الترخيص
هذا المشروع مصمم ليكون قابلاً لإعادة البيع والاستخدام للوكالات والشركات (White-Label MIT License).
