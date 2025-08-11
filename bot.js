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

// Global scope variables
const wyrAnswers = {}; // Stores Would You Rather answers

// ===================== SCENES =====================
// Profile creation wizard
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

// Profile editing wizard
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

// ===================== DATABASE FUNCTIONS =====================
async function connectDB() {
  try {
    await client.connect();
    db = client.db();
    usersCollection = db.collection("users");
    matchesCollection = db.collection("matches");
    conversationsCollection = db.collection("conversations");
    adminCollection = db.collection("admin");

    // Drop existing telegramId index if it exists
    try {
      await usersCollection.dropIndex("telegramId_1");
      console.log("Dropped existing telegramId index");
    } catch (dropError) {
      if (dropError.codeName !== "NamespaceNotFound") {
        throw dropError;
      }
    }

    // Create indexes
    await usersCollection.createIndex({ location: "2dsphere" });
    await usersCollection.createIndex(
      { referralCode: 1 },
      { unique: true, sparse: true }
    );
    await usersCollection.createIndex({ telegramId: 1 }, { unique: true }); // Add unique here
    await matchesCollection.createIndex({ telegramId1: 1, telegramId2: 1 });

    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
}

// Simulated reverse geocoding function
async function reverseGeocode(lat, lon) {
  return `Near ${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

// ===================== NOTIFICATION FUNCTIONS =====================
async function sendLikeNotification(likerId, likedId) {
  try {
    const liker = await usersCollection.findOne({ telegramId: likerId });
    if (!liker) return;

    const username = liker.username ? `@${liker.username}` : liker.name;
    const message = `💖 ${
      liker.first_name || liker.name
    } (${username}) liked your profile!`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback("👀 View Profile", `view_profile_${likerId}`),
      Markup.button.callback("💌 Message", `message_${likerId}`),
    ]);

    await bot.telegram.sendMessage(likedId, message, keyboard);
  } catch (error) {
    console.error("Error sending like notification:", error);
    // Send error to admin if needed
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Failed to send like notification from ${likerId} to ${likedId}: ${error.message}`
      );
    }
  }
}

// ===================== MATCHING FUNCTIONS =====================
async function findMatch(ctx, maxDistance = 50) {
  try {
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
        await usersCollection.updateOne(
          { telegramId },
          { $inc: { referralCredits: -1 } }
        );
        await ctx.reply(
          `✨ You're using a premium match credit (remaining: ${
            user.referralCredits - 1
          })`
        );
        return showMatch(ctx, premiumMatch);
      }
    }

    // Determine interested gender
    let interestedGender;
    if (user.interestedIn === "Male") interestedGender = "Male";
    else if (user.interestedIn === "Female") interestedGender = "Female";
    else interestedGender = { $in: ["Male", "Female"] };

    // Find users who match the criteria
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

    // Base query
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
          $maxDistance: maxDistance * 1000,
        },
      };
    }

    const potentialMatch = await usersCollection.findOne(query);

    if (!potentialMatch) {
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
  } catch (error) {
    console.error("Error in findMatch:", error);
    await ctx.reply(
      "An error occurred while searching for matches. Please try again."
    );
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in findMatch for user ${ctx.from.id}: ${error.message}`
      );
    }
  }
}

async function findPremiumMatch(user, telegramId) {
  try {
    let interestedGender;
    if (user.interestedIn === "Male") interestedGender = "Male";
    else if (user.interestedIn === "Female") interestedGender = "Female";
    else interestedGender = { $in: ["Male", "Female"] };

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

    return await usersCollection.findOne({
      telegramId: { $nin: excludedtelegramIds },
      gender: interestedGender,
      active: true,
      interestedIn: { $in: [user.gender, "Both"] },
      referralCredits: { $gt: 0 },
    });
  } catch (error) {
    console.error("Error in findPremiumMatch:", error);
    return null;
  }
}
async function showMatches(ctx) {
  try {
    const telegramId = ctx.from.id;
    const user = await usersCollection.findOne({ telegramId });

    if (!user) {
      await ctx.reply("Please create a profile first.");
      return ctx.scene.enter("profile-wizard");
    }

    // Find all matches where status is "matched"
    const matches = await matchesCollection
      .find({
        $or: [
          { telegramId1: telegramId, status: "matched" },
          { telegramId2: telegramId, status: "matched" },
        ],
      })
      .toArray();

    if (matches.length === 0) {
      await ctx.reply("You don't have any matches yet. Keep searching!");
      return;
    }

    for (const match of matches) {
      const matchId =
        match.telegramId1 === telegramId
          ? match.telegramId2
          : match.telegramId1;
      const matchedUser = await usersCollection.findOne({
        telegramId: matchId,
      });

      if (matchedUser) {
        await showMatch(ctx, matchedUser);
      }
    }
  } catch (error) {
    console.error("Error in showMatches:", error);
    await ctx.reply("An error occurred while loading your matches.");
  }
}

async function showMatch(ctx, match) {
  try {
    const user = await usersCollection.findOne({ telegramId: ctx.from.id });
    if (!user) {
      await ctx.reply("Please create a profile first.");
      return ctx.scene.enter("profile-wizard");
    }

    let distanceInfo = "";
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

    let score = 0;
    if (user.gender === match.interestedIn) score++;
    if (user.interestedIn === match.gender) score++;
    if (user.city && match.city && user.city === match.city) score++;
    if (user.age && match.age && Math.abs(user.age - match.age) <= 5) score++;

    const caption = `Name: ${match.name || "Unknown"}\nAge: ${
      match.age || "Not specified"
    }\nGender: ${match.gender || "Not specified"}\nBio: ${
      match.bio || "No bio provided"
    }${distanceInfo}\n\n💯 Match Score: ${score}/4`;

    let photoToSend = match.photo || process.env.DEFAULT_PROFILE_PHOTO;

    await ctx.replyWithPhoto(photoToSend, {
      caption: caption,
      ...Markup.inlineKeyboard([
        Markup.button.callback("👍 Like", `like_${match.telegramId}`),
        Markup.button.callback("👎 Dislike", `dislike_${match.telegramId}`),
        Markup.button.callback("📍 Distance Filter", "distance_filter"),
        Markup.button.callback("💬 Message", `message_${match.telegramId}`),
      ]),
    });
  } catch (error) {
    console.error("Error in showMatch:", error);
    await ctx.reply("Couldn't show this profile. Please try again.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in showMatch for user ${ctx.from.id}: ${error.message}`
      );
    }
  }
}

// ===================== LIKE/DISLIKE HANDLERS =====================
bot.action(/like_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const likerId = ctx.from.id;
    const likedId = parseInt(ctx.match[1]);

    // Check for existing match
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

      // Send notification to the liked user
      await sendLikeNotification(likerId, likedId);
      await ctx.reply("Like sent! If they like you back, you'll be notified.");
    }

    await ctx.deleteMessage();
    await findMatch(ctx);
  } catch (error) {
    console.error("Error in like handler:", error);
    await ctx.answerCbQuery("Failed to process like. Please try again.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in like handler for ${ctx.from.id}: ${error.message}`
      );
    }
  }
});

bot.action(/dislike_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
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
  } catch (error) {
    console.error("Error in dislike handler:", error);
    await ctx.answerCbQuery("Failed to process dislike. Please try again.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in dislike handler for ${ctx.from.id}: ${error.message}`
      );
    }
  }
});

// ===================== MAIN MENU AND PROFILE FUNCTIONS =====================
async function showMainMenu(ctx) {
  try {
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

    if (ADMIN_IDS.includes(telegramId)) {
      await ctx.reply(
        "Admin Menu:",
        Markup.keyboard([
          ["📊 Stats", "📢 Broadcast"],
          ["🔙 User Menu"],
        ]).resize()
      );
    }
  } catch (error) {
    console.error("Error in showMainMenu:", error);
    await ctx.reply("An error occurred. Please try again.");
  }
}

async function showUserProfile(ctx) {
  try {
    const telegramId = ctx.from.id;
    const user = await usersCollection.findOne({ telegramId });

    if (!user) {
      await ctx.reply("Please create a profile first.");
      return ctx.scene.enter("profile-wizard");
    }

    let locationInfo = user.city
      ? `\nLocation: ${user.city}`
      : "\nLocation: Not specified";

    const caption = `Your Profile:\n\nName: ${user.name}\nAge: ${
      user.age
    }\nGender: ${user.gender}\nInterested In: ${user.interestedIn}\nBio: ${
      user.bio
    }${locationInfo}\n\n🎁 Referral Credits: ${user.referralCredits || 0}`;

    await ctx.replyWithPhoto(user.photo || process.env.DEFAULT_PROFILE_PHOTO, {
      caption: caption,
      ...Markup.inlineKeyboard([
        Markup.button.callback("✏️ Edit Profile", "edit_profile"),
        Markup.button.callback("🎁 Referral Program", "show_referral"),
      ]),
    });
  } catch (error) {
    console.error("Error in showUserProfile:", error);
    await ctx.reply("Couldn't load your profile. Please try again.");
  }
}

// ===================== MESSAGE HANDLING =====================
async function handleMessage(ctx, recipientId, text) {
  try {
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

    // Forward message to recipient
    const sender = await usersCollection.findOne({ telegramId: senderId });
    const username = sender.username ? `@${sender.username}` : sender.name;

    await bot.telegram.sendMessage(
      recipientId,
      `New message from ${sender.name} (${username}):\n\n${text}`,
      Markup.inlineKeyboard([
        Markup.button.callback("💌 Reply", `message_${senderId}`),
        Markup.button.callback(
          "🔗 Share My Username",
          `share_username_${senderId}`
        ),
        Markup.button.callback(
          "🎲 Would You Rather",
          `fun_question_${senderId}`
        ),
      ])
    );

    await ctx.reply("Message sent!");
  } catch (error) {
    console.error("Error in handleMessage:", error);
    await ctx.reply("Failed to send message. Please try again.");
  }
}

// ===================== BROADCAST FUNCTIONS =====================
async function sendBroadcast(ctx, message, keyboard = null) {
  try {
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

        try {
          await bot.telegram.pinChatMessage(
            telegramId,
            sentMessage.message_id,
            {
              disable_notification: true,
            }
          );
        } catch (pinError) {
          console.error(`Couldn't pin for ${telegramId}:`, pinError.message);
        }
      } catch (err) {
        console.error(`Failed to send to ${telegramId}:`, err.message);
        failCount++;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await ctx.reply(
      `Broadcast completed!\nSuccess: ${successCount}\nFailed: ${failCount}`
    );
  } catch (error) {
    console.error("Error in sendBroadcast:", error);
    await ctx.reply("Failed to send broadcast. Please try again.");
  }
}

async function sendPhotoReminderBroadcast() {
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();
    const usersCollection = db.collection("users");

    const usersWithDefaultPhoto = await usersCollection
      .find({ photo: process.env.DEFAULT_PROFILE_PHOTO })
      .toArray();

    console.log(
      `Found ${usersWithDefaultPhoto.length} users with default photos`
    );

    let successCount = 0;
    let failCount = 0;

    const message = `🌟 Personalize Your Profile! 🌟

We noticed you're still using the default profile photo. Upload your own photo to get up to 5x more matches!

Here's how to update your photo:
1. Tap "👤 My Profile"
2. Select "✏️ Edit Profile"
3. Choose "Photo"
4. Upload your best picture

💡 Pro Tip: Use a clear, friendly photo where your face is visible for best results!`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback("📸 Update Photo Now", "edit_profile_photo"),
    ]);

    for (const user of usersWithDefaultPhoto) {
      try {
        await bot.telegram.sendMessage(user.telegramId, message, keyboard);
        successCount++;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`Failed to send to ${user.telegramId}:`, error.message);
        failCount++;
      }
    }

    console.log(
      `Broadcast completed: ${successCount} sent, ${failCount} failed`
    );
  } catch (error) {
    console.error("Error in photo reminder broadcast:", error);
  } finally {
    await client.close();
  }
}

// ===================== ADMIN FUNCTIONS =====================
async function showAdminStats(ctx) {
  try {
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
  } catch (error) {
    console.error("Error in showAdminStats:", error);
    await ctx.reply("Failed to load statistics. Please try again.");
  }
}

// ===================== BOT COMMANDS =====================
bot.start(async (ctx) => {
  try {
    const referralCode = ctx.startPayload;
    const referrer = referralCode
      ? await usersCollection.findOne({ referralCode })
      : null;

    if (!(await usersCollection.findOne({ telegramId: ctx.from.id }))) {
      const newUserData = {
        telegramId: ctx.from.id,
        createdAt: new Date(),
        active: true,
        referralCredits: 0,
        referralCount: 0,
      };

      if (referrer) {
        await usersCollection.updateOne(
          { telegramId: referrer.telegramId },
          {
            $inc: { referralCount: 1, referralCredits: 1 },
            $set: { lastReferralAt: new Date() },
          }
        );

        newUserData.referredBy = referrer.telegramId;
        newUserData.referralCredits = 1;

        await ctx.reply(
          `🎉 You joined using ${referrer.name}'s referral link! You've received 1 premium match credit.`
        );
        await bot.telegram.sendMessage(
          referrer.telegramId,
          `🎊 ${ctx.from.first_name} joined using your referral link! You've earned 1 premium match credit.`
        );
        return ctx.scene.enter("profile-wizard");
      }

      await ctx.scene.enter("profile-wizard");
    }

    await ctx.reply(
      `💖 Find people near you who share your vibes — in just 2 minutes!\n\nWelcome to the Dating Bot!\n\n\n\n v${version}`
    );
    await showMainMenu(ctx);
  } catch (error) {
    console.error("Error in start command:", error);
    await ctx.reply("An error occurred during startup. Please try again.");
  }
});

// ... (other commands remain similar but with added error handling)
bot.command("version", (ctx) => {
  ctx.reply(`🤖 Bot version: v${version}`);
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
    await ctx.telegram.sendMessage(
      likedId,
      `${liker.name} liked you!`,
      Markup.inlineKeyboard([
        Markup.button.callback("💬 Message", `message_${likerId}`),
      ])
    );
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
        "What’s a dream you’ve never said out loud?",
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

// ===================== ERROR HANDLING =====================
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("An unexpected error occurred. Please try again.");
  if (ADMIN_IDS.length > 0) {
    bot.telegram
      .sendMessage(
        ADMIN_IDS[0],
        `Bot error: ${err.message}\nUser: ${ctx.from.id}`
      )
      .catch(console.error);
  }
});

// ===================== START BOT =====================
async function startBot() {
  try {
    await connectDB();
    await bot.telegram.setMyShortDescription(
      `Welcome to Konvo — the easiest way to meet interesting people right here on Telegram.\n🤖 v${version}`
    );
    await bot.launch();
    console.log("Dating bot is running...");
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

startBot();
