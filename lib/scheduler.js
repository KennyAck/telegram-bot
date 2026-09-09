// lib/scheduler.js
// محرك الجدولة: يفحص كل دقيقة (بتوقيت آسيا/الرياض) هل يوجد موعد نشر مستحق لأي قناة.
// لا يوجد أي تعويض (Catch-up) للمواعيد الفائتة: إن لم يُطابق الوقت الحالي موعداً بدقة، يُتجاهل التيك تماماً.

const cron = require('node-cron');
const { getRiyadhNow } = require('./time');

function startScheduler(bot, supabase) {
  // تعمل في بداية كل دقيقة اعتماداً على ساعة النظام (UTC)، ثم نحسب داخلياً وقت الرياض
  cron.schedule('* * * * *', () => {
    tick(bot, supabase).catch((err) => {
      console.error('خطأ غير متوقع في دورة الجدولة:', err.message);
    });
  });

  console.log('✅ تم تشغيل محرك الجدولة (فحص كل دقيقة - توقيت Asia/Riyadh)');
}

async function tick(bot, supabase) {
  const { hhmm, date } = getRiyadhNow();

  // جلب كل المواعيد النشطة المطابقة للوقت الحالي والتي لم تُنفَّذ اليوم بعد
  const { data: dueSchedules, error } = await supabase
    .from('channel_schedules')
    .select('id, chat_id, time_of_day, last_triggered_date')
    .eq('is_active', true)
    .eq('time_of_day', hhmm)
    .or(`last_triggered_date.is.null,last_triggered_date.neq.${date}`);

  if (error) {
    console.error('فشل جلب المواعيد المستحقة:', error.message);
    return;
  }
  if (!dueSchedules || dueSchedules.length === 0) return;

  // معالجة كل موعد بمعزل عن الآخر: فشل قناة واحدة لا يوقف بقية القنوات
  for (const schedule of dueSchedules) {
    try {
      await processSchedule(bot, supabase, schedule, date);
    } catch (err) {
      console.error(`خطأ غير متوقع أثناء معالجة الموعد ${schedule.id}:`, err.message);
    }
  }
}

async function processSchedule(bot, supabase, schedule, todayDate) {
  // خطوة 1: "حجز" هذا الموعد لليوم الحالي أولاً (Optimistic Locking عبر UPDATE شرطي)
  // هذا يمنع تنفيذ نفس الموعد مرتين في نفس اليوم حتى مع Restart أو تشغيل متزامن
  const { data: claimed, error: claimError } = await supabase
    .from('channel_schedules')
    .update({ last_triggered_date: todayDate })
    .eq('id', schedule.id)
    .eq('time_of_day', schedule.time_of_day)
    .or(`last_triggered_date.is.null,last_triggered_date.neq.${todayDate}`)
    .select();

  if (claimError) {
    console.error(`فشل حجز الموعد ${schedule.id}:`, claimError.message);
    return;
  }
  if (!claimed || claimed.length === 0) {
    // تم حجز هذا الموعد بالفعل من دورة أخرى (سباق نادر) — تجاهل آمن
    return;
  }

  // خطوة 2: التأكد أن القناة ما زالت نشطة قبل المتابعة
  const { data: channel } = await supabase
    .from('channels')
    .select('chat_id, is_active')
    .eq('chat_id', schedule.chat_id)
    .single();

  if (!channel || !channel.is_active) return;

  // خطوة 3: تحديد الرسالة التالية عبر progress (progress لا علاقة له بالتوقيت إطلاقاً)
  const { data: prog } = await supabase
    .from('progress')
    .select('last_message_id')
    .eq('chat_id', schedule.chat_id)
    .single();

  const currentMsgId = prog ? prog.last_message_id : 0;
  const nextMsgId = currentMsgId + 1;

  const { data: message } = await supabase
    .from('messages')
    .select('id, content')
    .eq('id', nextMsgId)
    .single();

  if (!message) {
    // لا توجد رسالة جديدة بعد في قاعدة البيانات — لا نرسل شيئاً، وهذا ليس خطأً
    return;
  }

  // خطوة 4: حجز رقم الرسالة قبل الإرسال الفعلي (Claim-before-Send)
  // هذا يضمن عدم تكرار الإرسال حتى لو فشل bot.sendMessage أو تعطل السيرفر بعد هذه النقطة مباشرة
  const { data: progressClaimed, error: progressClaimError } = await supabase
    .from('progress')
    .update({ last_message_id: nextMsgId })
    .eq('chat_id', schedule.chat_id)
    .eq('last_message_id', currentMsgId)
    .select();

  if (progressClaimError) {
    console.error(`فشل حجز الرسالة للقناة ${schedule.chat_id}:`, progressClaimError.message);
    return;
  }
  if (!progressClaimed || progressClaimed.length === 0) {
    // موعد آخر أو دورة موازية سبقتنا بحجز هذه الرسالة
    return;
  }

  // خطوة 5: الإرسال الفعلي عبر Telegram
  try {
    await bot.sendMessage(schedule.chat_id, message.content);
    console.log(`✅ تم إرسال الرسالة ${message.id} للقناة ${schedule.chat_id} في الموعد ${schedule.time_of_day}`);
  } catch (err) {
    console.error(`❌ فشل إرسال الرسالة للقناة ${schedule.chat_id}:`, err.message);

    // إن كان سبب الفشل فقدان صلاحية النشر/الإشراف، نعطّل القناة تلقائياً لمنع محاولات متكررة فاشلة
    const permissionLost =
      /kicked|not enough rights|CHAT_ADMIN_REQUIRED|have no rights|chat not found/i.test(err.message || '');

    if (permissionLost) {
      await supabase.from('channels').update({ is_active: false }).eq('chat_id', schedule.chat_id);
      console.warn(`⚠️ تم تعطيل القناة ${schedule.chat_id} تلقائياً بسبب فقدان صلاحيات البوت`);
    }
    // ملاحظة مهمة: progress تم تحديثه بالفعل قبل محاولة الإرسال (حجز مسبق).
    // لذلك عند فشل الإرسال، لن تُعاد هذه الرسالة تلقائياً في المرة القادمة —
    // بل ينتظر النظام الموعد التالي (تفضيل تخطي رسالة نادراً على تكرارها في قناة عامة).
  }
}

module.exports = { startScheduler };
