// lib/time.js
// أدوات تطبيع/تحليل الوقت المُدخل من المستخدم، والتعامل مع توقيت آسيا/الرياض (مكة المكرمة)

const RIYADH_TZ = 'Asia/Riyadh';

// تحويل الأرقام العربية-الهندية (٠-٩) إلى أرقام لاتينية إن وُجدت في إدخال المستخدم
function normalizeDigits(str) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return str.replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)));
}

/**
 * يحلل نص وقت مكتوب بصيغة عربية مثل "8:30ص" أو "08:30 م" أو "8:30 ص"
 * يعيد { hour24, minute, normalized } عند النجاح، أو null إذا كانت الصيغة/القيم غير صالحة
 */
function parseArabicTime(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;

  const input = normalizeDigits(rawInput.trim());
  // يسمح بمسافات اختيارية حول ":" وقبل مؤشر الفترة (ص/م)
  const match = input.match(/^(\d{1,2})\s*:\s*(\d{1,2})\s*([صم])$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const period = match[3];

  if (hour < 1 || hour > 12) return null;
  if (minute < 0 || minute > 59) return null;

  let hour24;
  if (period === 'م') {
    hour24 = hour === 12 ? 12 : hour + 12;
  } else {
    hour24 = hour === 12 ? 0 : hour;
  }

  const normalized = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { hour24, minute, normalized };
}

/**
 * يحوّل صيغة 24 ساعة "HH:MM" إلى نص عرض عربي مثل "08:30 ص"
 */
function formatArabicTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'ص' : 'م';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * يعيد الوقت الحالي بتوقيت آسيا/الرياض على شكل:
 * { hhmm: 'HH:MM', date: 'YYYY-MM-DD' }
 * مستقل تماماً عن توقيت السيرفر (Render) أو جهاز المستخدم.
 */
function getRiyadhNow() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  // بعض بيئات التشغيل تعيد الساعة "24" بدل "00" عند منتصف الليل — نطبّعها احتياطاً
  const hour = map.hour === '24' ? '00' : map.hour;

  return {
    hhmm: `${hour}:${map.minute}`,
    date: `${map.year}-${map.month}-${map.day}`
  };
}

module.exports = { parseArabicTime, formatArabicTime, getRiyadhNow, normalizeDigits };
