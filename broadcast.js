module.exports = function startBroadcast(bot, usersCollection) {
  const dailyMessages = [
  "📢 Day 1: Hey Konvo fam 💌! Start your journey with love and positivity today ✨.",
  "📢 Day 2: Remember, communication is key 🔑. Send a sweet text today ❤️.",
  "📢 Day 3: Love is an adventure 🌍. Be open to new connections 💕.",
  "📢 Day 4: A little kindness goes a long way 💌. Surprise someone with it today.",
  "📢 Day 5: Weekend vibes 🎉! Cozy chats 💬 + flirty moments 😏 = perfect day.",
  "📢 Day 6: Laughter is love’s best language 😂❤️. Share a joke with someone today.",
  "📢 Day 7: Sundays are for slowing down 🌸. Appreciate someone who makes you smile.",
  "📢 Day 8: Confidence is attractive ✨. Be yourself, and love will follow.",
  "📢 Day 9: Send a compliment today 🌟. You’ll make someone’s whole mood better 💕.",
  "📢 Day 10: Flirty reminder 😏: A small text can spark a big smile 💌.",
  "📢 Day 11: Be curious, ask deep questions ☕. That’s how real connections grow ❤️.",
  "📢 Day 12: Don’t forget to care for yourself too 💫. Self-love attracts real love 💕.",
  "📢 Day 13: Try sending only emojis in a chat today 😍😂🔥. See how fun it gets!",
  "📢 Day 14: Mid-month check ✨. Love grows with patience, effort, and laughter ❤️.",
  "📢 Day 15: Halfway there 🌟! Who’s been your favorite Konvo so far?",
  "📢 Day 16: Surprise someone today 🎁. Even a sweet ‘hi’ counts 💌.",
  "📢 Day 17: Honesty is romantic 🔑. Don’t be afraid to share your real thoughts 💕.",
  "📢 Day 18: Spread love, not silence 💬✨. Reply faster today 😉.",
  "📢 Day 19: Saturday spark 🔥: Would you rather go on a fun date or a cozy night in?",
  "📢 Day 20: Weekend magic 🌸. Smile more today — it’s the best flirty signal 😉.",
  "📢 Day 21: Sundays are perfect for meaningful talks ☕. Who’s your safe person?",
  "📢 Day 22: Energy check ⚡. Positivity attracts positivity — stay radiant today ✨.",
  "📢 Day 23: Be the reason someone laughs today 😂❤️.",
  "📢 Day 24: A quick ‘good morning 🌞’ or ‘good night 🌙’ can warm hearts instantly 💌.",
  "📢 Day 25: Keep things playful 🎲. Flirting is just fun energy shared ❤️.",
  "📢 Day 26: Trust + loyalty 🔐 = strongest love. Invest in it 💕.",
  "📢 Day 27: Compliment someone’s vibe today ✨. It sticks longer than you think 💫.",
  "📢 Day 28: Be bold today 🌟. Send that message you’ve been holding back 😉.",
  "📢 Day 29: Almost 30 days 🎉! Keep showing love, keep receiving love ❤️.",
  "📢 Day 30: You made it 🌟! Keep shining, keep loving, and let Konvo be part of your story 💌."
];


  let currentDay = 0;

  async function sendDailyMessage() {
    if (currentDay >= dailyMessages.length) return; // stop after 30 days

    const message = dailyMessages[currentDay];
    try {
      const users = await usersCollection.find({}).toArray();
      for (const user of users) {
        if (user.telegramId) {
          await bot.telegram.sendMessage(user.telegramId, message);
        }
      }
      console.log(`✅ Sent Day ${currentDay + 1} broadcast.`);
      currentDay++;
    } catch (err) {
      console.error("❌ Broadcast error:", err);
    }
  }

  // Send immediately when bot starts
  sendDailyMessage();

  // Schedule every 24 hours (86,400,000 ms)
  setInterval(sendDailyMessage, 24 * 60 * 60 * 1000);
};
