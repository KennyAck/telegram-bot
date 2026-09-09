const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const { parseArabicTime, formatArabicTime } = require('./lib/time');
const { startScheduler } = require('./lib/scheduler');

const MAX_SCHEDULES_PER_CHANNEL = 24;

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// إعداد Webhook للبوت
const token = process.env.BOT_TOKEN;
const url = process.env.RENDER_EXTERNAL_URL; // Render بياخد رابط الخدمة تلقائياً
const bot = new TelegramBot(token);

if (url) {
  bot.setWebHook(`${url}/bot${token}`);
}

// استقبال تحديثات تيليغرام عبر Webhook
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// رابط خاص لـ UptimeRobot يمنع Render من النوم
// مهم: بما أن المواعيد الفائتة لا تُعوَّض، يجب إبقاء هذا الـ ping فعّالاً باستمرار
app.get('/', (req, res) => {
  res.send('Bot is active and awake!');
});

// حالة UI مؤقتة في الذاكرة: تتبع "المستخدم بصدد إدخال وقت موعد جديد"
// key: user chat_id → value: { channelChatId }
// هذه ليست بيانات حساسة أو دائمة؛ فقدانها عند إعادة تشغيل السيرفر غير ضار،
// يكفي أن يضغط المستخدم الزر مجدداً — لذلك لا داعي لتخزينها في قاعدة البيانات
const pendingScheduleInput = new Map();

// 1. أزرار القائمة الرئيسية
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📖 ما هو عمل البوت؟", callback_data: "about_bot" }],
      [{ text: "📢 قناة \"وأذّن في الناس\" (المستودع)", callback_data: "dev_channel" }],
      [{ text: "📩 تواصل معنا (للشكاوى والاقتراحات)", callback_data: "contact_us" }],
      [{ text: "⏰ إضافة موعد رسالة", callback_data: "add_schedule" }],
      [{ text: "📋 مواعيد النشر", callback_data: "list_schedules" }]
    ]
  }
};

// 2. أمر /start
bot.onText(/\/start/, (msg) => {
  const welcomeText = `أهلاً بك في بوت "وأذّن في الناس"! 🌿

خطوات تفعيل البوت في قناتك:
1️⃣ أضف البوت مشرفاً (Admin) في قناتك.
2️⃣ امنحه صلاحية "نشر الرسائل" (Post Messages).
3️⃣ أرسل لي معرف القناة هنا (مثال: @my_channel).

استخدم الأزرار أدناه للمزيد من التفاصيل:`;

  bot.sendMessage(msg.chat.id, welcomeText, mainKeyboard);
});

// ---------- دوال مساعدة لإدارة القنوات والمواعيد ----------

// جلب القنوات المملوكة لمستخدم معين (النشطة فقط)
async function getUserChannels(userId) {
  const { data, error } = await supabase
    .from('channels')
    .select('chat_id')
    .eq('owner_user_id', userId)
    .eq('is_active', true);

  if (error) {
    console.error('خطأ في جلب قنوات المستخدم:', error.message);
    return [];
  }
  return data || [];
}

// التحقق أن مستخدماً معيناً يملك قناة معينة
async function userOwnsChannel(userId, chatId) {
  const { data } = await supabase
    .from('channels')
    .select('chat_id')
    .eq('chat_id', chatId)
    .eq('owner_user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  return !!data;
}

// عرض قائمة اختيار القناة عند امتلاك المستخدم لأكثر من قناة
async function askWhichChannel(userChatId, channels, purpose) {
  const prefix = purpose === 'add' ? 'pick_channel_add' : 'pick_channel_list';
  const buttons = channels.map((c) => [{ text: c.chat_id, callback_data: `${prefix}:${c.chat_id}` }]);
  buttons.push([{ text: '🔙 رجوع', callback_data: 'back_main' }]);
  await bot.sendMessage(userChatId, '📢 لديك أكثر من قناة، الرجاء اختيار القناة أولاً:', {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function startAddScheduleFlow(userChatId, channelChatId) {
  pendingScheduleInput.set(userChatId, { channelChatId });
  await bot.sendMessage(
    userChatId,
    `⏰ حدد الوقت الذي تريد أن تُرسل فيه الرسالة للقناة ${channelChatId}.\n\nاكتب الوقت بالصيغة التالية:\n08:30ص\n\nمثال:\n8:30م`
  );
}

async function showSchedulesList(userChatId, channelChatId) {
  const { data: schedules, error } = await supabase
    .from('channel_schedules')
    .select('id, time_of_day')
    .eq('chat_id', channelChatId)
    .eq('is_active', true)
    .order('time_of_day', { ascending: true });

  if (error) {
    return bot.sendMessage(userChatId, 'حدث خطأ أثناء جلب المواعيد، حاول لاحقاً.');
  }

  if (!schedules || schedules.length === 0) {
    return bot.sendMessage(userChatId, `📅 لا توجد مواعيد نشر مضافة بعد للقناة ${channelChatId}.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'back_main' }]] }
    });
  }

  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  let text = `📅 مواعيد النشر (${channelChatId}):\n\n`;
  const buttons = schedules.map((s, i) => {
    const label = i < numberEmojis.length ? numberEmojis[i] : `${i + 1}.`;
    text += `${label} ${formatArabicTime(s.time_of_day)}\n`;
    return [{ text: `${formatArabicTime(s.time_of_day)}   🗑️`, callback_data: `del_sched:${s.id}` }];
  });
  buttons.push([{ text: '🔙 رجوع للقائمة الرئيسية', callback_data: 'back_main' }]);

  await bot.sendMessage(userChatId, text, { reply_markup: { inline_keyboard: buttons } });
}

// 3. الاستجابة عند الضغط على الأزرار
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === 'about_bot') {
      await bot.sendMessage(chatId, "📖 **عمل البوت:**\nهو بوت مخصص لنشر رسائل إسلامية وتوعوية قصيرة بشكل تلقائي في مواعيد ثابتة تحددها أنت لكل قناة.");

    } else if (data === 'dev_channel') {
      await bot.sendMessage(chatId, "📢 **قناة \"وأذّن في الناس\" (المستودع):**\n@islamicvideostorepost");

    } else if (data === 'contact_us') {
      await bot.sendMessage(chatId, "📩 **للشكاوى والاقتراحات:**\nالعبد الفقير إلى الله: @I_royalty_I");

    } else if (data === 'back_main') {
      pendingScheduleInput.delete(chatId);
      await bot.sendMessage(chatId, 'القائمة الرئيسية:', mainKeyboard);

    } else if (data === 'add_schedule') {
      const channels = await getUserChannels(userId);
      if (channels.length === 0) {
        await bot.sendMessage(chatId, '⚠️ لا توجد لديك قناة مفعّلة بعد. أرسل معرف قناتك (مثال: @my_channel) أولاً لربطها.');
      } else if (channels.length === 1) {
        await startAddScheduleFlow(chatId, channels[0].chat_id);
      } else {
        await askWhichChannel(chatId, channels, 'add');
      }

    } else if (data === 'list_schedules') {
      const channels = await getUserChannels(userId);
      if (channels.length === 0) {
        await bot.sendMessage(chatId, '⚠️ لا توجد لديك قناة مفعّلة بعد. أرسل معرف قناتك (مثال: @my_channel) أولاً لربطها.');
      } else if (channels.length === 1) {
        await showSchedulesList(chatId, channels[0].chat_id);
      } else {
        await askWhichChannel(chatId, channels, 'list');
      }

    } else if (data.startsWith('pick_channel_add:')) {
      const channelChatId = data.split(':')[1];
      if (await userOwnsChannel(userId, channelChatId)) {
        await startAddScheduleFlow(chatId, channelChatId);
      } else {
        await bot.sendMessage(chatId, '⚠️ لا يمكنك إدارة مواعيد هذه القناة.');
      }

    } else if (data.startsWith('pick_channel_list:')) {
      const channelChatId = data.split(':')[1];
      if (await userOwnsChannel(userId, channelChatId)) {
        await showSchedulesList(chatId, channelChatId);
      } else {
        await bot.sendMessage(chatId, '⚠️ لا يمكنك إدارة مواعيد هذه القناة.');
      }

    } else if (data.startsWith('del_sched:')) {
      const scheduleId = data.split(':')[1];

      const { data: schedule } = await supabase
        .from('channel_schedules')
        .select('id, chat_id')
        .eq('id', scheduleId)
        .single();

      if (!schedule) {
        await bot.sendMessage(chatId, 'هذا الموعد غير موجود (ربما تم حذفه مسبقاً).');
      } else if (!(await userOwnsChannel(userId, schedule.chat_id))) {
        await bot.sendMessage(chatId, '⚠️ لا يمكنك حذف مواعيد هذه القناة.');
      } else {
        await supabase.from('channel_schedules').delete().eq('id', scheduleId);
        await bot.sendMessage(chatId, '🗑️ تم حذف الموعد بنجاح.');
        await showSchedulesList(chatId, schedule.chat_id);
      }
    }
  } catch (err) {
    console.error('خطأ في معالجة الزر:', err.message);
  }

  bot.answerCallbackQuery(query.id);
});

// 4. معالجة الرسائل النصية: إدخال وقت موعد، أو إضافة قناة جديدة
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text) return;

  const userChatId = msg.chat.id;

  // (أ) المستخدم بصدد إدخال وقت موعد جديد
  if (pendingScheduleInput.has(userChatId)) {
    const { channelChatId } = pendingScheduleInput.get(userChatId);
    const parsed = parseArabicTime(text);

    if (!parsed) {
      return bot.sendMessage(
        userChatId,
        '⚠️ صيغة الوقت غير صحيحة. الرجاء الكتابة بالصيغة التالية:\n08:30ص\nمثال: 8:30م'
      );
    }

    // التحقق من الحد الأقصى (24 موعداً يومياً لكل قناة)
    const { count } = await supabase
      .from('channel_schedules')
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', channelChatId)
      .eq('is_active', true);

    if ((count || 0) >= MAX_SCHEDULES_PER_CHANNEL) {
      pendingScheduleInput.delete(userChatId);
      return bot.sendMessage(userChatId, `⚠️ لا يمكن إضافة المزيد من المواعيد. الحد الأقصى هو ${MAX_SCHEDULES_PER_CHANNEL} موعداً يومياً لكل قناة.`);
    }

    // التحقق من عدم تكرار نفس الموعد لهذه القناة
    const { data: existing } = await supabase
      .from('channel_schedules')
      .select('id')
      .eq('chat_id', channelChatId)
      .eq('time_of_day', parsed.normalized)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      pendingScheduleInput.delete(userChatId);
      return bot.sendMessage(userChatId, `⚠️ هذا الموعد (${formatArabicTime(parsed.normalized)}) موجود مسبقاً لهذه القناة.`);
    }

    const { error: insertError } = await supabase
      .from('channel_schedules')
      .insert({ chat_id: channelChatId, time_of_day: parsed.normalized, is_active: true });

    pendingScheduleInput.delete(userChatId);

    if (insertError) {
      console.error('فشل إضافة الموعد:', insertError.message);
      if (insertError.code === '23505') {
        return bot.sendMessage(userChatId, '⚠️ هذا الموعد موجود مسبقاً لهذه القناة.');
      }
      return bot.sendMessage(userChatId, 'حدث خطأ أثناء حفظ الموعد، حاول لاحقاً.');
    }

    return bot.sendMessage(userChatId, `✅ تم إضافة الموعد ${formatArabicTime(parsed.normalized)} بنجاح للقناة ${channelChatId}.`);
  }

  // (ب) ربط قناة جديدة أو إعادة ربطها — مع فرض قواعد الملكية الصارمة
  if (text.startsWith('@')) {
    const channelId = text.trim();

    try {
      const botMember = await bot.getChatMember(channelId, (await bot.getMe()).id);
      const isAdmin = ['administrator', 'creator'].includes(botMember.status);
      const canPostMessages = botMember.can_post_messages !== false;

      if (!isAdmin || !canPostMessages) {
        return bot.sendMessage(
          userChatId,
          `⚠️ **تنبيه:** لم يتم تفعيل القناة!\nيرجى رفع البوت كـ **Admin** في القناة ${channelId} والتأكد من إعطائه **صلاحية نشر الرسائل (Post Messages)** ثم أرسل المعرف مجدداً.`
        );
      }

      await handleChannelOwnership(userChatId, msg.from.id, channelId);

    } catch (err) {
      bot.sendMessage(userChatId, `❌ **عذراً!** البوت ليس عضواً في القناة ${channelId} أو المعرف غير صحيح. أضف البوت للقناة كـ Admin أولاً ثم حاول مجدداً.`);
    }
  }
});

// منطق ملكية القنوات الصارم — يُطبَّق حرفياً لمنع "سرقة" قناة مرتبطة بمستخدم آخر
async function handleChannelOwnership(userChatId, telegramUserId, channelId) {
  const { data: existingChannel, error: fetchError } = await supabase
    .from('channels')
    .select('chat_id, owner_user_id')
    .eq('chat_id', channelId)
    .maybeSingle();

  if (fetchError) {
    console.error('خطأ أثناء التحقق من ملكية القناة:', fetchError.message);
    return bot.sendMessage(userChatId, 'حدث خطأ في قاعدة البيانات أثناء التحقق من القناة، يرجى المحاولة لاحقاً.');
  }

  let dbError = null;

  if (!existingChannel) {
    // الحالة 1: قناة جديدة تماماً — تُربط بالمستخدم الحالي كمالك
    const { error } = await supabase
      .from('channels')
      .insert({ chat_id: channelId, is_active: true, owner_user_id: telegramUserId });
    dbError = error;

  } else if (existingChannel.owner_user_id === null) {
    // الحالة 2: قناة قديمة بلا مالك (من قبل نظام الملكية) — تُنسب للمستخدم الحالي
    const { error } = await supabase
      .from('channels')
      .update({ owner_user_id: telegramUserId, is_active: true })
      .eq('chat_id', channelId);
    dbError = error;

  } else if (Number(existingChannel.owner_user_id) === Number(telegramUserId)) {
    // الحالة 3: نفس المالك — إعادة تفعيل فقط
    const { error } = await supabase
      .from('channels')
      .update({ is_active: true })
      .eq('chat_id', channelId);
    dbError = error;

  } else {
    // الحالة 4: القناة مملوكة لمستخدم آخر — رفض تام، لا تغيير على المالك إطلاقاً
    return bot.sendMessage(userChatId, '⚠️ هذه القناة مربوطة مسبقاً بحساب آخر ولا يمكنك إدارتها.');
  }

  if (dbError) {
    console.error('خطأ أثناء حفظ القناة:', dbError.message);
    return bot.sendMessage(userChatId, 'حدث خطأ في قاعدة البيانات أثناء التفعيل، يرجى المحاولة لاحقاً.');
  }

  // إنشاء سجل progress فقط إن لم يكن موجوداً مسبقاً — لا نُصفّر تقدّم قناة يُعاد ربطها
  const { data: existingProgress, error: progFetchError } = await supabase
    .from('progress')
    .select('chat_id')
    .eq('chat_id', channelId)
    .maybeSingle();

  if (!progFetchError && !existingProgress) {
    await supabase.from('progress').insert({ chat_id: channelId, last_message_id: 0 });
  }

  bot.sendMessage(
    userChatId,
    `✅ تم التأكد من الصلاحيات وتفعيل القناة ${channelId} بنجاح!\nالآن أضف مواعيد النشر عبر زر "⏰ إضافة موعد رسالة".`,
    mainKeyboard
  );
}

// 5. تشغيل محرك الجدولة (يفحص كل دقيقة بتوقيت Asia/Riyadh — بدون تعويض مواعيد فائتة)
startScheduler(bot, supabase);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
