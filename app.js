const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "أهلاً بك! أضف البوت كـ Admin في قناتك، ثم أرسل لي معرف القناة (مثال: @my_channel) لتفعيل الإرسال التلقائي.");
});

bot.on('message', async (msg) => {
  const text = msg.text;
  if (text && text.startsWith('@')) {
    const channelId = text.trim();
    
    const { error: chError } = await supabase
      .from('channels')
      .upsert({ chat_id: channelId, is_active: true });

    const { error: prError } = await supabase
      .from('progress')
      .upsert({ chat_id: channelId, last_message_id: 0 });

    if (!chError && !prError) {
      bot.sendMessage(msg.chat.id, `تم تفعيل القناة ${channelId} بنجاح! سيبدأ البوت بنشر الرسائل تلقائياً.`);
    } else {
      bot.sendMessage(msg.chat.id, "حدث خطأ أثناء تفعيل القناة، تأكد من إضافة البوت كـ Admin أولاً.");
    }
  }
});

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

// يعمل كل ساعة
setInterval(processAutoMessaging, 10 * 1000);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
