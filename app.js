const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// 1. أزرار القائمة الرئيسية (3 أزرار مرتبة)
const mainKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "📖 ما هو عمل البوت؟", callback_data: "about_bot" }
      ],
      [
        { text: "📢 قناة \"وأذّن في الناس\" (المستودع)", callback_data: "dev_channel" }
      ],
      [
        { text: "📩 تواصل معنا (للشكاوى والاقتراحات)", callback_data: "contact_us" }
      ]
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

// 3. الاستجابة عند الضغط على الأزرار
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "about_bot") {
    await bot.sendMessage(chatId, "📖 **عمل البوت:**\nهو بوت مخصص لنشر رسائل إسلامية وتوعوية قصيرة بشكل تلقائي كل 8 ساعات في قناتك التي تم ربطه بها.");
  } else if (data === "dev_channel") {
    await bot.sendMessage(chatId, "📢 **قناة \"وأذّن في الناس\" (المستودع):**\n@islamicvideostorepost");
  } else if (data === "contact_us") {
    await bot.sendMessage(chatId, "📩 **للشكاوى والاقتراحات:**\nالعبد الفقير إلى الله: @I_royalty_I");
  }

  bot.answerCallbackQuery(query.id);
});

// 4. معالجة إضافة القناة والتحقق من الصلاحيات
bot.on('message', async (msg) => {
  const text = msg.text;
  if (text && text.startsWith('@')) {
    const channelId = text.trim();
    
    try {
      const botMember = await bot.getChatMember(channelId, (await bot.getMe()).id);
      const isAdmin = ['administrator', 'creator'].includes(botMember.status);
      const canPostMessages = botMember.can_post_messages !== false;

      if (!isAdmin || !canPostMessages) {
        return bot.sendMessage(
          msg.chat.id, 
          `⚠️ **تنبيه:** لم يتم تفعيل القناة!\nيرجى رفع البوت كـ **Admin** في القناة ${channelId} والتأكد من إعطائه **صلاحية نشر الرسائل (Post Messages)** ثم أرسل المعرف مجدداً.`
        );
      }

      const { error: chError } = await supabase
        .from('channels')
        .upsert({ chat_id: channelId, is_active: true });

      const { error: prError } = await supabase
        .from('progress')
        .upsert({ chat_id: channelId, last_message_id: 0 });

      if (!chError && !prError) {
        bot.sendMessage(msg.chat.id, `✅ تم التأكد من الصلاحيات وتفعيل القناة ${channelId} بنجاح!\nسيبدأ البوت بنشر الرسائل تلقائياً كل 8 ساعات.`);
        processAutoMessaging(); // إرسال أول رسالة فوراً
      } else {
        bot.sendMessage(msg.chat.id, "حدث خطأ في قاعدة البيانات أثناء التفعيل، يرجى المحاولة لاحقاً.");
      }

    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ **عذراً!** البوت ليس عضواً في القناة ${channelId} أو المعرف غير صحيح. أضف البوت للقناة كـ Admin أولاً ثم حاول مجدداً.`);
    }
  }
});

// 5. المحرك التلقائي للإرسال
async function processAutoMessaging() {
  const { data: channels } = await supabase.from('channels').select('chat_id').eq('is_active', true);
  if (!channels) return;

  for (const channel of channels) {
    const { data: prog } = await supabase.from('progress').select('last_message_id').eq('chat_id', channel.chat_id).single();
    const currentMsgId = prog ? prog.last_message_id : 0;
    const nextMsgId = currentMsgId + 1;

    const { data: message } = await supabase.from('messages').select('id, content').eq('id', nextMsgId).single();

    if (message) {
      try {
        await bot.sendMessage(channel.chat_id, message.content);
        await supabase.from('progress').upsert({ chat_id: channel.chat_id, last_message_id: message.id });
        console.log(`تم الإرسال بنجاح للقناة: ${channel.chat_id}`);
      } catch (err) {
        console.error(`فشل الإرسال للقناة ${channel.chat_id}:`, err.message);
      }
    }
  }
}

// يعمل كل 8 ساعات تلقائياً (8 hours * 60 mins * 60 secs * 1000 ms)
setInterval(processAutoMessaging, 10 * 1000); 

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
