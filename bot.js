require("dotenv").config();
const { Telegraf, Markup, Scenes, session } = require("telegraf");
const { MongoClient } = require("mongodb");
const geodist = require("geodist");
const { version } = require("./package.json");

// Database connection
const client = new MongoClient(process.env.MONGODB_URI);
let db,
  usersCollection,
  matchesCollection,
  conversationsCollection,
  adminCollection;

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map(Number)
  : [];

// Place this at the top of your file (global scope)
const wyrAnswers = {}; // { questionKey: { [userId]: { answerIndex, mood } } }

// Wizard scenes for profile creation
const profileWizard = new Scenes.WizardScene(
  "profile-wizard",
  async (ctx) => {
    await ctx.reply("Let's create your dating profile!\nWhat's your name?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.name = ctx.message.text;
    await ctx.reply("How old are you?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const age = parseInt(ctx.message.text);
    if (isNaN(age) || age < 18 || age > 120) {
      await ctx.reply("Please enter a valid age (18-120)");
      return;
    }
    ctx.wizard.state.age = age;
    await ctx.reply(
      "What's your gender?",
      Markup.keyboard(["Male", "Female"]).oneTime()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.gender = ctx.message.text;
    // Set interestedIn automatically
    ctx.wizard.state.interestedIn =
      ctx.message.text === "Male" ? "Female" : "Male";
    await ctx.reply("Tell us about yourself (bio):");
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.bio = ctx.message.text;
    await ctx.reply(
      "Please share your location (city name or send your current location):",
      Markup.keyboard([
        [Markup.button.locationRequest("📍 Send Current Location")],
        ["Skip Location"],
      ])
        .oneTime()
        .resize()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message.photo) {
      await ctx.reply("Please upload a photo");
      return;
    }

    ctx.wizard.state.photo = ctx.message.photo[0].file_id;

    // Save profile to database
    const telegramId = ctx.from.id;
    const profile = {
      telegramId,
      name: ctx.wizard.state.name,
      age: ctx.wizard.state.age,
      gender: ctx.wizard.state.gender,
      interestedIn: ctx.wizard.state.interestedIn,
      bio: ctx.wizard.state.bio,
      photo: ctx.wizard.state.photo,
      city: ctx.wizard.state.city,
      location: ctx.wizard.state.location,
      active: true,
      createdAt: new Date(),
      referralCredits: ctx.wizard.state.referralCredits || 0,
      referredBy: ctx.wizard.state.referredBy || null,
    };

    // Generate referral code if not exists
    if (!profile.referralCode) {
      profile.referralCode = `KONVO-${Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase()}`;
    }

    await usersCollection.updateOne(
      { telegramId },
      { $set: profile },
      { upsert: true }
    );

    await ctx.reply("Profile created successfully!", Markup.removeKeyboard());
    await showMainMenu(ctx);
    return ctx.scene.leave();
  }
);

// Wizard scenes for editing profile
const editProfileWizard = new Scenes.WizardScene(
  "edit-profile-wizard",
  async (ctx) => {
    await ctx.reply(
      "What would you like to edit?",
      Markup.keyboard([
        ["Name", "Age"],
        ["Gender"],
        ["Bio", "Photo"],
        ["Location"],
        ["Cancel"],
      ]).oneTime()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const choice = ctx.message.text;
    ctx.wizard.state.editField = choice;

    if (choice === "Cancel") {
      await ctx.reply("Edit cancelled.", Markup.removeKeyboard());
      await showMainMenu(ctx);
      return ctx.scene.leave();
    }

    if (choice === "Photo") {
      await ctx.reply("Upload your new profile picture:");
      return ctx.wizard.next();
    }

    if (choice === "Location") {
      await ctx.reply(
        "Please share your location (city name or send your current location):",
        Markup.keyboard([
          [Markup.button.locationRequest("📍 Send Current Location")],
          ["Skip Location"],
        ]).oneTime()
      );
      return ctx.wizard.next();
    }

    await ctx.reply(`Enter your new ${choice.toLowerCase()}:`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const field = ctx.wizard.state.editField;
    const telegramId = ctx.from.id;
    let update = {};

    if (field === "Photo") {
      if (!ctx.message.photo) {
        await ctx.reply("Please upload a photo");
        return;
      }
      update.photo = ctx.message.photo[0].file_id;
    } else if (field === "Age") {
      const age = parseInt(ctx.message.text);
      if (isNaN(age) || age < 18 || age > 120) {
        await ctx.reply("Please enter a valid age (18-120)");
        return;
      }
      update.age = age;
    } else if (field === "Name") {
      update.name = ctx.message.text;
    } else if (field === "Gender") {
      update.gender = ctx.message.text;
    } else if (field === "Interested In") {
      update.interestedIn = ctx.message.text;
    } else if (field === "Bio") {
      update.bio = ctx.message.text;
    } else if (field === "Location") {
      if (ctx.message.location) {
        update.location = {
          type: "Point",
          coordinates: [
            ctx.message.location.longitude,
            ctx.message.location.latitude,
          ],
        };
        update.city = await reverseGeocode(
          ctx.message.location.latitude,
          ctx.message.location.longitude
        );
      } else if (ctx.message.text !== "Skip Location") {
        update.city = ctx.message.text;
        update.location = null;
      }
    }

    await usersCollection.updateOne({ telegramId }, { $set: update });

    await ctx.reply(`${field} updated successfully!`, Markup.removeKeyboard());
    await showMainMenu(ctx);
    return ctx.scene.leave();
  }
);

// Admin broadcast wizard
const broadcastWizard = new Scenes.WizardScene(
  "broadcast-wizard",
  async (ctx) => {
    await ctx.reply("Enter the message you want to broadcast to all users:");
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message.text) {
      await ctx.reply("Please enter a valid message");
      return;
    }

    ctx.wizard.state.message = ctx.message.text;
    await ctx.reply(
      "Would you like to include a button?",
      Markup.keyboard([["Yes", "No"], ["Cancel"]]).oneTime()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message.text === "Cancel") {
      await ctx.reply("Broadcast cancelled.", Markup.removeKeyboard());
      return ctx.scene.leave();
    }

    if (ctx.message.text === "Yes") {
      await ctx.reply('Enter button text and URL in format: "Text|URL"');
      return ctx.wizard.next();
    }

    // No button, send broadcast
    await sendBroadcast(ctx, ctx.wizard.state.message);
    return ctx.scene.leave();
  },
  async (ctx) => {
    if (ctx.message.text.includes("|")) {
      const [text, url] = ctx.message.text.split("|");
      const button = Markup.button.url(text.trim(), url.trim());

      await sendBroadcast(
        ctx,
        ctx.wizard.state.message,
        Markup.inlineKeyboard([button])
      );
    } else {
      await ctx.reply("Invalid format. Broadcast sent without button.");
      await sendBroadcast(ctx, ctx.wizard.state.message);
    }

    return ctx.scene.leave();
  }
);

// Set up stage with scenes
const stage = new Scenes.Stage([
  profileWizard,
  editProfileWizard,
  broadcastWizard,
]);
bot.use(session());
bot.use(stage.middleware());

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db();
    usersCollection = db.collection("users");
    matchesCollection = db.collection("matches");
    conversationsCollection = db.collection("conversations");
    adminCollection = db.collection("admin");

    // Create index for location-based searches
    await usersCollection.createIndex({ location: "2dsphere" });
    // Create index for referral code
    await usersCollection.createIndex(
      { referralCode: 1 },
      { unique: true, sparse: true }
    );

    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
}

// Simulated reverse geocoding function
async function reverseGeocode(lat, lon) {
  // In a real app, you would use a geocoding service like Google Maps or OpenStreetMap
  return `Near ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

// Main menu
async function showMainMenu(ctx) {
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  if (!user) {
    return ctx.scene.enter("profile-wizard");
  }

  await ctx.reply(
    "Main Menu:",
    Markup.keyboard([
      ["🔍 Find Match", "💌 My Matches"],
      ["👤 My Profile", "✏️ Edit Profile"],
      ["❤️ Who Liked Me", "🎁 Referral Program"],
      ["🚪 Deactivate Profile"],
    ]).resize()
  );

  // Show admin menu if user is admin
  if (ADMIN_IDS.includes(telegramId)) {
    await ctx.reply(
      "Admin Menu:",
      Markup.keyboard([["📊 Stats", "📢 Broadcast"], ["🔙 User Menu"]]).resize()
    );
  }
}

// Admin menu
async function showAdminMenu(ctx) {
  await ctx.reply(
    "Admin Menu:",
    Markup.keyboard([["📊 Stats", "📢 Broadcast"], ["🔙 User Menu"]]).resize()
  );
}

// Find potential matches with location filter
async function findMatch(ctx, maxDistance = 50) {
  // 50 km default radius
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  if (!user) {
    await ctx.reply("Please create a profile first.");
    return ctx.scene.enter("profile-wizard");
  }

  // Check for premium matches first if user has credits
  if (user.referralCredits > 0) {
    const premiumMatch = await findPremiumMatch(user, telegramId);
    if (premiumMatch) {
      // Deduct credit
      await usersCollection.updateOne(
        { telegramId },
        { $inc: { referralCredits: -1 } }
      );
      await ctx.reply(
        "✨ You're using a premium match credit (remaining: " +
          (user.referralCredits - 1) +
          ")"
      );
      return showMatch(ctx, premiumMatch);
    }
  }

  // Determine interested gender
  let interestedGender;
  if (user.interestedIn === "Male") interestedGender = "Male";
  else if (user.interestedIn === "Female") interestedGender = "Female";
  else interestedGender = { $in: ["Male", "Female"] };

  // Find users who match the criteria and haven't been matched/disliked before
  const alreadyMatched = await matchesCollection
    .find({
      $or: [{ telegramId1: telegramId }, { telegramId2: telegramId }],
    })
    .toArray();

  const excludedtelegramIds = [
    telegramId,
    ...alreadyMatched
      .filter(
        (m) =>
          // Exclude if matched, disliked, or you already liked them (pending)
          m.status === "matched" ||
          m.status === "disliked" ||
          (m.status === "pending" && m.telegramId1 === telegramId)
      )
      .map((m) =>
        m.telegramId1 === telegramId ? m.telegramId2 : m.telegramId1
      ),
  ];

  // Base query without location
  let query = {
    telegramId: { $nin: excludedtelegramIds },
    gender: interestedGender,
    active: true,
    interestedIn: { $in: [user.gender, "Both"] },
  };

  // Add location filter if available
  if (user.location) {
    query.location = {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: user.location.coordinates,
        },
        $maxDistance: maxDistance * 1000, // Convert km to meters
      },
    };
  }

  const potentialMatch = await usersCollection.findOne(query);

  if (!potentialMatch) {
    // Try without location filter if no matches found
    if (user.location) {
      delete query.location;
      const potentialMatchWithoutLocation = await usersCollection.findOne(
        query
      );

      if (potentialMatchWithoutLocation) {
        await ctx.reply(
          "No nearby matches found. Showing matches from other locations:"
        );
        return showMatch(ctx, potentialMatchWithoutLocation);
      }
    }

    await ctx.reply(
      "No more matches available at the moment. Check back later!"
    );
    return;
  }

  await showMatch(ctx, potentialMatch);
}

// Find premium matches (users with referral credits)
async function findPremiumMatch(user, telegramId) {
  // Determine interested gender
  let interestedGender;
  if (user.interestedIn === "Male") interestedGender = "Male";
  else if (user.interestedIn === "Female") interestedGender = "Female";
  else interestedGender = { $in: ["Male", "Female"] };

  // Find users who match the criteria and haven't been matched/disliked before
  const alreadyMatched = await matchesCollection
    .find({
      $or: [{ telegramId1: telegramId }, { telegramId2: telegramId }],
    })
    .toArray();

  const excludedtelegramIds = [
    telegramId,
    ...alreadyMatched
      .filter(
        (m) =>
          m.status === "matched" ||
          m.status === "disliked" ||
          (m.status === "pending" && m.telegramId1 === telegramId)
      )
      .map((m) =>
        m.telegramId1 === telegramId ? m.telegramId2 : m.telegramId1
      ),
  ];

  // Find premium users first
  const premiumMatch = await usersCollection.findOne({
    telegramId: { $nin: excludedtelegramIds },
    gender: interestedGender,
    active: true,
    interestedIn: { $in: [user.gender, "Both"] },
    referralCredits: { $gt: 0 },
  });

  return premiumMatch;
}

// Show a match with distance information
async function showMatch(ctx, match) {
  const user = await usersCollection.findOne({ telegramId: ctx.from.id });
  let distanceInfo = "";

  if (user.location && match.location) {
    const distance = geodist(
      { lat: user.location.coordinates[1], lon: user.location.coordinates[0] },
      {
        lat: match.location.coordinates[1],
        lon: match.location.coordinates[0],
      },
      { unit: "km" }
    );
    distanceInfo = `\nDistance: ~${Math.round(distance)} km`;
  } else if (match.city) {
    distanceInfo = `\nLocation: ${match.city}`;
  }

  // Calculate score (example: +1 for each matching field)
  let score = 0;
  if (user.gender === match.interestedIn) score++;
  if (user.interestedIn === match.gender) score++;
  if (user.city && match.city && user.city === match.city) score++;
  if (user.age && match.age && Math.abs(user.age - match.age) <= 5) score++;

  const caption = `Name: ${match.name}\nAge: ${match.age}\nGender: ${match.gender}\nBio: ${match.bio}${distanceInfo}\n\n💯 Match Score: ${score}/4`;

  await ctx.replyWithPhoto(match.photo, {
    caption: caption,
    ...Markup.inlineKeyboard([
      Markup.button.callback("👍 Like", `like_${match.telegramId}`),
      Markup.button.callback("👎 Dislike", `dislike_${match.telegramId}`),
      Markup.button.callback("📍 Distance Filter", "distance_filter"),
      Markup.button.callback("💬 Message", `message_${match.telegramId}`),
    ]),
  });
}

// Show user's matches
async function showMatches(ctx) {
  const telegramId = ctx.from.id;

  const userMatches = await matchesCollection
    .find({
      $or: [
        { telegramId1: telegramId, status: "matched" },
        { telegramId2: telegramId, status: "matched" },
      ],
    })
    .toArray();

  if (userMatches.length === 0) {
    await ctx.reply("You have no matches yet. Keep searching!");
    return;
  }

  const matchtelegramIds = userMatches.map((m) =>
    m.telegramId1 === telegramId ? m.telegramId2 : m.telegramId1
  );

  const matches = await usersCollection
    .find({
      telegramId: { $in: matchtelegramIds },
    })
    .toArray();

  for (const match of matches) {
    let distanceInfo = "";
    const user = await usersCollection.findOne({ telegramId });

    if (user.location && match.location) {
      const distance = geodist(
        {
          lat: user.location.coordinates[1],
          lon: user.location.coordinates[0],
        },
        {
          lat: match.location.coordinates[1],
          lon: match.location.coordinates[0],
        },
        { unit: "km" }
      );
      distanceInfo = `\nDistance: ~${Math.round(distance)} km`;
    } else if (match.city) {
      distanceInfo = `\nLocation: ${match.city}`;
    }

    const caption = `Name: ${match.name}\nAge: ${match.age}\nGender: ${match.gender}${distanceInfo}`;

    await ctx.replyWithPhoto(match.photo, {
      caption: caption,
      ...Markup.inlineKeyboard([
        Markup.button.callback("💬 Message", `message_${match.telegramId}`),
        Markup.button.callback("❌ Unmatch", `unmatch_${match.telegramId}`),
      ]),
    });
  }
}

// Show user profile
async function showUserProfile(ctx) {
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  if (!user) {
    await ctx.reply("Please create a profile first.");
    return ctx.scene.enter("profile-wizard");
  }

  let locationInfo = "";
  if (user.city) {
    locationInfo = `\nLocation: ${user.city}`;
  } else {
    locationInfo = "\nLocation: Not specified";
  }

  const caption = `Your Profile:\n\nName: ${user.name}\nAge: ${
    user.age
  }\nGender: ${user.gender}\nInterested In: ${user.interestedIn}\nBio: ${
    user.bio
  }${locationInfo}\n\n🎁 Referral Credits: ${user.referralCredits || 0}`;

  await ctx.replyWithPhoto(user.photo, {
    caption: caption,
    ...Markup.inlineKeyboard([
      Markup.button.callback("✏️ Edit Profile", "edit_profile"),
      Markup.button.callback("🎁 Referral Program", "show_referral"),
    ]),
  });
}

// Handle messages between matched users
async function handleMessage(ctx, recipientId, text) {
  const senderId = ctx.from.id;

  // Check if users are matched
  const match = await matchesCollection.findOne({
    $or: [
      { telegramId1: senderId, telegramId2: recipientId, status: "matched" },
      { telegramId1: recipientId, telegramId2: senderId, status: "matched" },
    ],
  });

  if (!match) {
    await ctx.reply("You are not matched with this user.");
    return;
  }

  // Save message to database
  await conversationsCollection.insertOne({
    senderId,
    recipientId,
    text,
    timestamp: new Date(),
  });

  // Forward message to recipient with "Share My Username" button
  const sender = await usersCollection.findOne({ telegramId: senderId });
  await bot.telegram.sendMessage(
    recipientId,
    `New message from ${sender.name}:\n\n${text}`,
    Markup.inlineKeyboard([
      Markup.button.callback("💌 Reply", `message_${senderId}`),
      Markup.button.callback(
        "🔗 Share My Username",
        `share_username_${senderId}`
      ),
      Markup.button.callback("🎲 Would You Rather", `fun_question_${senderId}`),
    ])
  );

  await ctx.reply("Message sent!");
}

// Send broadcast to all users
async function sendBroadcast(ctx, message, keyboard = null) {
  const telegramIds = await usersCollection.distinct("telegramId");
  let successCount = 0;
  let failCount = 0;

  await ctx.reply(`Starting broadcast to ${telegramIds.length} users...`);

  for (const telegramId of telegramIds) {
    try {
      let sentMessage;
      if (keyboard) {
        sentMessage = await bot.telegram.sendMessage(
          telegramId,
          message,
          keyboard
        );
      } else {
        sentMessage = await bot.telegram.sendMessage(telegramId, message);
      }
      successCount++;

      // Attempt to pin in each user's chat (if bot has admin rights)
      try {
        await bot.telegram.pinChatMessage(telegramId, sentMessage.message_id, {
          disable_notification: true,
        });
      } catch (pinError) {
        console.error(`Couldn't pin for ${telegramId}:`, pinError.message);
      }
    } catch (err) {
      console.error(`Failed to send to ${telegramId}:`, err.message);
      failCount++;
    }

    // Rate limiting delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await ctx.reply(
    `Broadcast completed!\nSuccess: ${successCount}\nFailed: ${failCount}`
  );
}
// Show admin stats
async function showAdminStats(ctx) {
  const totalUsers = await usersCollection.countDocuments();
  const activeUsers = await usersCollection.countDocuments({ active: true });
  const totalMatches = await matchesCollection.countDocuments({
    status: "matched",
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const newUsersToday = await usersCollection.countDocuments({
    createdAt: { $gte: today },
  });

  // Referral stats
  const usersWithReferrals = await usersCollection.countDocuments({
    referralCount: { $gt: 0 },
  });
  const totalReferrals = await usersCollection.countDocuments({
    referredBy: { $exists: true },
  });

  const statsMessage = `
📊 Bot Statistics:
    
👥 Total Users: ${totalUsers}
✅ Active Users: ${activeUsers}
💞 Total Matches: ${totalMatches}
🆕 New Users Today: ${newUsersToday}
    
📌 Referral Stats:
🎁 Users with referrals: ${usersWithReferrals}
👥 Total referrals: ${totalReferrals}
    `;

  await ctx.reply(statsMessage);
}

// Bot commands and handlers
bot.start(async (ctx) => {
  // Check for referral code in start parameter
  const referralCode = ctx.startPayload;
  const referrer = referralCode
    ? await usersCollection.findOne({ referralCode })
    : null;

  // New user flow
  if (!(await usersCollection.findOne({ telegramId: ctx.from.id }))) {
    const newUserData = {
      telegramId: ctx.from.id,
      createdAt: new Date(),
      active: true,
      referralCredits: 0,
      referralCount: 0,
    };

    if (referrer) {
      // Update referrer's stats
      await usersCollection.updateOne(
        { telegramId: referrer.telegramId },
        {
          $inc: {
            referralCount: 1,
            referralCredits: 1,
          },
          $set: {
            lastReferralAt: new Date(),
          },
        }
      );

      // Set referral info for new user
      newUserData.referredBy = referrer.telegramId;
      newUserData.referralCredits = 1; // New user also gets credit

      // Notify both parties
      await ctx.reply(
        `🎉 You joined using ${referrer.name}'s referral link! You've received 1 premium match credit.`
      );

      await bot.telegram.sendMessage(
        referrer.telegramId,
        `🎊 ${ctx.from.first_name} joined using your referral link! You've earned 1 premium match credit.`
      );
      return ctx.scene.enter("profile-wizard");
    }

    // Create new user
    await usersCollection.insertOne(newUserData);
  }

  await ctx.reply(
    `💖 Find people near you who share your vibes — in just 2 minutes!\n\nWelcome to the Dating Bot!\n\n\n\n v${version}`
  );
  await showMainMenu(ctx);
});

bot.command("referral", async (ctx) => {
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  if (!user) {
    await ctx.reply("Please create a profile first with /start");
    return;
  }

  // Generate a unique referral code if not exists
  let referralCode = user.referralCode;
  if (!referralCode) {
    referralCode = `KONVO-${Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase()}`;
    await usersCollection.updateOne({ telegramId }, { $set: { referralCode } });
  }

  const referralMessage = `
🎁 *Referral Program*

Invite friends to join Konvo and earn rewards!

Your referral code: \`${referralCode}\`

🔗 Or use this link:
https://t.me/${ctx.botInfo.username}?start=${referralCode}

*How it works:*
1. Share your code/link with friends
2. When they join using your code, you both get:
   - 💎 1 premium match (shown first in searches)
   - 🔥 Priority in matching algorithms
3. After 5 successful referrals:
   - 🚀 Get featured in our "Popular Users" section

Your stats:
👥 Referrals: ${user.referralCount || 0}
💎 Credits: ${user.referralCredits || 0}
`;

  await ctx.replyWithMarkdown(
    referralMessage,
    Markup.inlineKeyboard([
      Markup.button.url(
        "Share",
        `https://t.me/share/url?url=https://t.me/${ctx.botInfo.username}?start=${referralCode}&text=Join%20Konvo%20dating%20bot%20with%20my%20referral%20code%20${referralCode}`
      ),
    ])
  );
});

bot.command("version", (ctx) => {
  ctx.reply(`🤖 Bot version: v${version}`);
});

// Admin referral commands
bot.command("referralstats", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const topReferrers = await usersCollection
    .aggregate([
      { $match: { referralCount: { $gt: 0 } } },
      { $sort: { referralCount: -1 } },
      { $limit: 10 },
      { $project: { name: 1, referralCount: 1, telegramId: 1 } },
    ])
    .toArray();

  let stats = "🏆 Top Referrers:\n\n";
  topReferrers.forEach((user, index) => {
    stats += `${index + 1}. ${user.name} (ID: ${user.telegramId}): ${
      user.referralCount
    } referrals\n`;
  });

  const totalReferrals = await usersCollection.countDocuments({
    referredBy: { $exists: true },
  });
  stats += `\nTotal referrals: ${totalReferrals}`;

  await ctx.reply(stats);
});

bot.command("addcredits", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply("Unauthorized");
    return;
  }

  const [_, telegramId, amount] = ctx.message.text.split(" ");
  if (!telegramId || !amount) {
    await ctx.reply("Usage: /addcredits [telegramId] [amount]");
    return;
  }

  await usersCollection.updateOne(
    { telegramId: parseInt(telegramId) },
    { $inc: { referralCredits: parseInt(amount) } }
  );

  await ctx.reply(`Added ${amount} credits to user ${telegramId}`);
  await bot.telegram.sendMessage(
    telegramId,
    `🎉 Admin has granted you ${amount} premium match credits!`
  );
});

// User menu commands
bot.hears("🔍 Find Match", async (ctx) => {
  await findMatch(ctx);
});

bot.hears("💌 My Matches", async (ctx) => {
  await showMatches(ctx);
});

bot.hears("👤 My Profile", async (ctx) => {
  await showUserProfile(ctx);
});

bot.hears("✏️ Edit Profile", async (ctx) => {
  await ctx.scene.enter("edit-profile-wizard");
});

bot.hears("🚪 Deactivate Profile", async (ctx) => {
  const telegramId = ctx.from.id;
  await usersCollection.updateOne({ telegramId }, { $set: { active: false } });
  await ctx.reply(
    "Your profile has been deactivated. Use /start to reactivate it."
  );
});
bot.hears("🎁 Referral Program", async (ctx) => {
  try {
    await ctx.scene.leave();

    const telegramId = ctx.from.id;
    const user = await usersCollection.findOne({ telegramId });

    if (!user) {
      await ctx.reply("Please create a profile first with /start");
      return;
    }

    // Generate a unique referral code if not exists
    let referralCode = user.referralCode;
    if (!referralCode) {
      referralCode = `KONVO-${Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase()}`;
      await usersCollection.updateOne(
        { telegramId },
        { $set: { referralCode } }
      );
    }

    // Using MarkdownV2 with proper escaping
    const referralMessage = `
<b>🎁 Referral Program</b>

Invite friends to join Konvo and earn rewards!

Your referral code: <code>${referralCode}</code>

🔗 Or use this link:
https://t.me/${ctx.botInfo.username}?start=${referralCode}

<b>How it works:</b>
1. Share your code/link with friends
2. When they join using your code, you both get:
   - 💎 1 premium match (shown first in searches)
   - 🔥 Priority in matching algorithms
3. After 5 successful referrals:
   - 🚀 Get featured in our "Popular Users" section

Your stats:
👥 Referrals: ${user.referralCount || 0}
💎 Credits: ${user.referralCredits || 0}
`;

    const shareText = `Join Konvo dating bot with my referral code ${referralCode}\n\n🔗 https://t.me/${ctx.botInfo.username}?start=${referralCode}`;
    const shareUrl = `https://t.me/share/url?text=${encodeURIComponent(
      shareText
    )}`;

    await ctx.replyWithHTML(referralMessage, {
      ...Markup.inlineKeyboard([Markup.button.url("📤 Share Now", shareUrl)]),
    });
  } catch (err) {
    console.error("Error in referral program:", err);
    await ctx.reply(
      "An error occurred while opening the referral program. Please try again."
    );
  }
});

bot.action("show_referral", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.telegram.emit("command", "referral", ctx);
});

// Admin menu commands
bot.hears("🔙 User Menu", async (ctx) => {
  await showMainMenu(ctx);
});

bot.hears("📊 Stats", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply("You are not authorized to view stats.");
    return;
  }
  await showAdminStats(ctx);
});

bot.hears("📢 Broadcast", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply("You are not authorized to send broadcasts.");
    return;
  }
  await ctx.scene.enter("broadcast-wizard");
});
bot.hears("❤️ Who Liked Me", async (ctx) => {
  const telegramId = ctx.from.id;
  // Find users who liked me but I haven't liked/disliked them yet
  const pendingLikes = await matchesCollection
    .find({
      telegramId2: telegramId,
      status: "pending",
    })
    .toArray();

  if (pendingLikes.length === 0) {
    await ctx.reply("No one has liked you yet. Keep searching!");
    return;
  }

  const likerIds = pendingLikes.map((m) => m.telegramId1);
  const likers = await usersCollection
    .find({ telegramId: { $in: likerIds } })
    .toArray();

  for (const liker of likers) {
    await ctx.replyWithPhoto(liker.photo, {
      caption: `Name: ${liker.name}\nAge: ${liker.age}\nGender: ${liker.gender}\nBio: ${liker.bio}`,
      ...Markup.inlineKeyboard([
        Markup.button.callback("👍 Like Back", `like_${liker.telegramId}`),
        Markup.button.callback("👎 Dislike", `dislike_${liker.telegramId}`),
      ]),
    });
  }
});

// Handle inline buttons
bot.action(/like_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const likerId = ctx.from.id;
  const likedId = parseInt(ctx.match[1]);

  // Check if the liked user has already liked the current user
  const existingMatch = await matchesCollection.findOne({
    $or: [
      { telegramId1: likedId, telegramId2: likerId },
      { telegramId1: likerId, telegramId2: likedId },
    ],
  });

  if (existingMatch) {
    if (
      existingMatch.telegramId1 === likedId &&
      existingMatch.status === "pending"
    ) {
      // It's a match!
      await matchesCollection.updateOne(
        { _id: existingMatch._id },
        { $set: { status: "matched", matchedAt: new Date() } }
      );

      // Notify both users
      const liker = await usersCollection.findOne({ telegramId: likerId });
      const liked = await usersCollection.findOne({ telegramId: likedId });

      await ctx.reply(
        `It's a match! You and ${liked.name} have liked each other.`
      );
      await ctx.telegram.sendMessage(
        likedId,
        `It's a match! You and ${liker.name} have liked each other.`,
        Markup.inlineKeyboard([
          Markup.button.callback("💬 Message", `message_${likerId}`),
        ])
      );
    }
  } else {
    // Create a new pending match
    await matchesCollection.insertOne({
      telegramId1: likerId,
      telegramId2: likedId,
      status: "pending",
      createdAt: new Date(),
    });

    await ctx.reply("Like sent! If they like you back, you'll be notified.");
  }

  await ctx.deleteMessage();
  await findMatch(ctx);
});

bot.action(/dislike_(\d+)/, async (ctx) => {
  const dislikerId = ctx.from.id;
  const dislikedId = parseInt(ctx.match[1]);

  // Record the dislike
  await matchesCollection.insertOne({
    telegramId1: dislikerId,
    telegramId2: dislikedId,
    status: "disliked",
    createdAt: new Date(),
  });

  await ctx.deleteMessage();
  await findMatch(ctx);
});

bot.action(/message_(\d+)/, async (ctx) => {
  const recipientId = parseInt(ctx.match[1]);
  ctx.session.recipientId = recipientId;

  // Ask for mood
  await ctx.reply(
    "Choose your mood for this message:",
    Markup.keyboard([["😏 Flirty", "😊 Friendly", "🧠 Deep Talk"]])
      .oneTime()
      .resize()
  );
  ctx.session.waitingForMood = true;
});

// When user selects a mood, prompt for message, then send message on next input
bot.on("message", async (ctx) => {
  // Step 1: User selects mood
  if (ctx.session.waitingForMood && ctx.session.recipientId) {
    ctx.session.lastMood = ctx.message.text;
    ctx.session.waitingForMood = false;
    ctx.session.waitingForMessage = true;

    // Mood-based recommendations
    const moodSuggestions = {
      "😏 Flirty": [
        "If you could take me on a date anywhere, where would it be?",
        "What's your most charming quality?",
        "Should we skip the small talk and flirt a little? 😉",
      ],
      "😊 Friendly": [
        "What's your favorite way to spend a weekend?",
        "If you could have any superpower, what would it be?",
        "What's something that always makes you smile?",
      ],
      "🧠 Deep Talk": [
        "What's a dream you've never said out loud?",
        "What do you value most in a friendship?",
        "If you could change one thing about the world, what would it be?",
      ],
    };
    const mood = ctx.session.lastMood;
    const suggestions = moodSuggestions[mood] || [];
    const randomSuggestion =
      suggestions.length > 0
        ? suggestions[Math.floor(Math.random() * suggestions.length)]
        : "Say hi!";

    await ctx.reply(
      "Type your message:",
      Markup.keyboard([[randomSuggestion]])
        .oneTime()
        .resize()
    );
    return;
  }

  // Step 2: User sends actual message
  if (ctx.session.waitingForMessage && ctx.session.recipientId) {
    await handleMessage(ctx, ctx.session.recipientId, ctx.message.text);
    ctx.session.waitingForMessage = false;
    ctx.session.recipientId = null;
    await ctx.reply("Message sent!", Markup.removeKeyboard());
    return;
  }
});

// In your fun_question handler, generate a unique questionKey and store mood in session
bot.action(/fun_question_(\d+)/, async (ctx) => {
  const recipientId = parseInt(ctx.match[1]);
  const senderId = ctx.from.id;

  // Would You Rather questions
  const wouldYouRather = [
    {
      q: "Would you rather be able to fly or be invisible?",
      a: ["Fly", "Invisible"],
    },
    {
      q: "Would you rather always have to sing instead of speak or dance everywhere you go?",
      a: ["Sing", "Dance"],
    },
    {
      q: "Would you rather travel to the past or the future?",
      a: ["Past", "Future"],
    },
    {
      q: "Would you rather never use social media again or never watch another movie?",
      a: ["No social media", "No movies"],
    },
    {
      q: "Would you rather have pizza or burgers for the rest of your life?",
      a: ["Pizza", "Burgers"],
    },
    {
      q: "Would you rather be able to talk to animals or speak every language?",
      a: ["Talk to animals", "Speak every language"],
    },
    {
      q: "Would you rather always be 10 minutes late or always be 20 minutes early?",
      a: ["10 min late", "20 min early"],
    },
    {
      q: "Would you rather live by the beach or in the mountains?",
      a: ["Beach", "Mountains"],
    },
    {
      q: "Would you rather have unlimited free travel or never have to pay for food at restaurants?",
      a: ["Free travel", "Free food"],
    },
    {
      q: "Would you rather be able to teleport anywhere or read minds?",
      a: ["Teleport", "Read minds"],
    },
  ];

  const random =
    wouldYouRather[Math.floor(Math.random() * wouldYouRather.length)];

  // Generate a unique questionKey (timestamp + sender + recipient)
  const questionKey = `${Date.now()}_${senderId}_${recipientId}`;
  ctx.session.wyrQuestionKey = questionKey;
  ctx.session.wyrMood = ctx.session.lastMood || "😊 Friendly";

  // Send to both users with interactive buttons
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(random.a[0], `wyr_${questionKey}_0`),
      Markup.button.callback(random.a[1], `wyr_${questionKey}_1`),
    ],
  ]);

  await ctx.reply(`🎲 Would You Rather: ${random.q}`, keyboard);
  if (recipientId !== senderId) {
    await ctx.telegram.sendMessage(
      recipientId,
      `🎲 Would You Rather: ${random.q}`,
      keyboard
    );
  }
});

// In your wyr answer handler:
bot.action(/wyr_(.+)_(\d)/, async (ctx) => {
  const questionKey = ctx.match[1];
  const answerIndex = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || "Someone";
  const mood = ctx.session.wyrMood || "😊 Friendly";

  // Store the answer and mood
  if (!wyrAnswers[questionKey]) wyrAnswers[questionKey] = {};
  wyrAnswers[questionKey][userId] = { answerIndex, mood };

  // If both users have answered
  const userIds = Object.keys(wyrAnswers[questionKey]);
  if (userIds.length === 2) {
    const [userA, userB] = userIds;
    const a = wyrAnswers[questionKey][userA];
    const b = wyrAnswers[questionKey][userB];

    if (a.answerIndex === b.answerIndex) {
      // Mood-based congrats
      let congratsMsg = "";
      if (a.mood === "😏 Flirty" && b.mood === "😏 Flirty") {
        congratsMsg =
          "🔥 It's a flirty match! You both chose the same and are in a flirty mood! Maybe it's fate? 😉";
      } else if (a.mood === "😊 Friendly" && b.mood === "😊 Friendly") {
        congratsMsg =
          "🎉 Friendly vibes! You both picked the same and are in a friendly mood. Great minds think alike!";
      } else if (a.mood === "🧠 Deep Talk" && b.mood === "🧠 Deep Talk") {
        congratsMsg =
          "💡 Deep connection! You both chose the same and are in a deep talk mood. Profound!";
      } else {
        congratsMsg =
          "👏 You both picked the same! Looks like you have something in common!";
      }
      await ctx.telegram.sendMessage(userA, congratsMsg);
      await ctx.telegram.sendMessage(userB, congratsMsg);
    }
    // Clean up
    delete wyrAnswers[questionKey];
  }

  await ctx.reply(`${userName} chose option ${answerIndex === 0 ? "1" : "2"}!`);
  await ctx.answerCbQuery("Answer submitted!");
});

// Error handling
bot.catch((err, ctx) => {
  console.error("Error:", err);
  ctx.reply("An error occurred. Please try again.");
});

bot.action(/share_username_(\d+)/, async (ctx) => {
  const recipientId = parseInt(ctx.match[1]);
  const sender = ctx.from;
  const username = sender.username;

  // Update the database with the latest username
  await usersCollection.updateOne(
    { telegramId: sender.id },
    { $set: { username: username || null } }
  );

  if (username) {
    await bot.telegram.sendMessage(
      recipientId,
      `${sender.first_name}${
        sender.last_name ? " " + sender.last_name : ""
      } (@${username}) has shared their Telegram username with you!`
    );
    await ctx.reply("Your username has been shared.");
  } else {
    await ctx.reply(
      "You don't have a Telegram username set. Please set one in Telegram settings."
    );
  }
});

async function startBot() {
  await connectDB();
  await bot.telegram.setMyShortDescription(
    `Welcome to Konvo — the easiest way to meet interesting people right here on Telegram.\n🤖 v${version}`
  );
  await bot.launch();
  console.log("Dating bot is running...");
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

startBot();
