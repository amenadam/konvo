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
    // Get all users to exclude
    const excludedRecords = await matchesCollection
      .find({
        $or: [{ telegramId1: telegramId }, { telegramId2: telegramId }],
        status: { $in: ["disliked", "removed", "matched", "pending"] },
      })
      .toArray();

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

    // Find all matches where current user has disliked someone or been disliked
    const dislikeRecords = await matchesCollection
      .find({
        $or: [
          { telegramId1: telegramId, status: "disliked" }, // Users I've disliked
          { telegramId2: telegramId, status: "disliked" }, // Users who disliked me
        ],
      })
      .toArray();

    const excludedtelegramIds = [
      telegramId,
      ...excludedRecords.map((record) =>
        record.telegramId1 === telegramId
          ? record.telegramId2
          : record.telegramId1
      ),
      // Also exclude users I've already matched with or liked
      ...(
        await matchesCollection
          .find({
            $or: [{ telegramId1: telegramId }, { telegramId2: telegramId }],
            status: { $in: ["matched", "pending"] },
          })
          .toArray()
      ).map((record) =>
        record.telegramId1 === telegramId
          ? record.telegramId2
          : record.telegramId1
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

    // Find all dislike records
    const dislikeRecords = await matchesCollection
      .find({
        $or: [
          { telegramId1: telegramId, status: "disliked" },
          { telegramId2: telegramId, status: "disliked" },
        ],
      })
      .toArray();

    const excludedtelegramIds = [
      telegramId,
      ...dislikeRecords.map((record) =>
        record.telegramId1 === telegramId
          ? record.telegramId2
          : record.telegramId1
      ),
      // Also exclude existing matches
      ...(
        await matchesCollection
          .find({
            $or: [{ telegramId1: telegramId }, { telegramId2: telegramId }],
            status: { $in: ["matched", "pending"] },
          })
          .toArray()
      ).map((record) =>
        record.telegramId1 === telegramId
          ? record.telegramId2
          : record.telegramId1
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
        Markup.button.callback("🚫 Remove", `remove_${match.telegramId}`),
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

    // Check if this dislike already exists
    const existingDislike = await matchesCollection.findOne({
      $or: [
        {
          telegramId1: dislikerId,
          telegramId2: dislikedId,
          status: "disliked",
        },
        {
          telegramId1: dislikedId,
          telegramId2: dislikerId,
          status: "disliked",
        },
      ],
    });

    if (!existingDislike) {
      // Record the dislike
      await matchesCollection.insertOne({
        telegramId1: dislikerId,
        telegramId2: dislikedId,
        status: "disliked",
        createdAt: new Date(),
      });
    }

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
        //Markup.button.callback(
        //"🎲 Would You Rather",
        //`fun_question_${senderId}`
        //),
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

bot.action(/view_profile_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const profileId = parseInt(ctx.match[1]);
    const profile = await usersCollection.findOne({ telegramId: profileId });

    if (!profile) {
      await ctx.reply("Profile not found.");
      return;
    }

    let distanceInfo = "";
    const user = await usersCollection.findOne({ telegramId: ctx.from.id });

    if (user.location && profile.location) {
      const distance = geodist(
        {
          lat: user.location.coordinates[1],
          lon: user.location.coordinates[0],
        },
        {
          lat: profile.location.coordinates[1],
          lon: profile.location.coordinates[0],
        },
        { unit: "km" }
      );
      distanceInfo = `\nDistance: ~${Math.round(distance)} km`;
    } else if (profile.city) {
      distanceInfo = `\nLocation: ${profile.city}`;
    }

    const caption = `Name: ${profile.name || "Unknown"}\nAge: ${
      profile.age || "Not specified"
    }\nGender: ${profile.gender || "Not specified"}\nBio: ${
      profile.bio || "No bio provided"
    }${distanceInfo}`;

    await ctx.replyWithPhoto(
      profile.photo || process.env.DEFAULT_PROFILE_PHOTO,
      {
        caption: caption,
        ...Markup.inlineKeyboard([
          Markup.button.callback("👍 Like", `like_${profile.telegramId}`),
          Markup.button.callback("👎 Dislike", `dislike_${profile.telegramId}`),
          Markup.button.callback("💬 Message", `message_${profile.telegramId}`),
        ]),
      }
    );
  } catch (error) {
    console.error("Error in view_profile handler:", error);
    await ctx.answerCbQuery("Failed to view profile. Please try again.");
  }
});
bot.action(/remove_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const removerId = ctx.from.id;
    const removedId = parseInt(ctx.match[1]);

    // Create a permanent remove record
    await matchesCollection.insertOne({
      telegramId1: removerId,
      telegramId2: removedId,
      status: "removed",
      createdAt: new Date(),
    });

    await ctx.reply(
      "This user has been removed from your potential matches and won't appear again."
    );
    await ctx.deleteMessage();
    await findMatch(ctx);
  } catch (error) {
    console.error("Error in remove handler:", error);
    await ctx.answerCbQuery("Failed to remove user. Please try again.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in remove handler for ${ctx.from.id}: ${error.message}`
      );
    }
  }
});
// ===================== REFERRAL PROGRAM =====================
bot.hears("🎁 Referral Program", async (ctx) => {
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  if (!user) {
    await ctx.reply("Please create a profile first.");
    return ctx.scene.enter("profile-wizard");
  }

  const referralMessage = `🎁 Referral Program 🎁

Invite friends and earn premium match credits!

Your referral code: ${user.referralCode}

How it works:
1. Share your referral link below
2. When someone joins using your link:
   - You get 1 premium match credit
   - They get 1 premium match credit
3. Premium matches are shown first to other premium users

Your credits: ${user.referralCredits || 0}
People you've referred: ${user.referralCount || 0}`;

  const referralLink = `https://t.me/${
    (await bot.telegram.getMe()).username
  }?start=${user.referralCode}`;

  await ctx.reply(
    referralMessage,
    Markup.inlineKeyboard([
      Markup.button.url(
        "📤 Share Referral Link",
        `https://t.me/share/url?url=${encodeURIComponent(
          referralLink
        )}&text=Join%20me%20on%20this%20dating%20bot!%20Use%20my%20code%20${
          user.referralCode
        }%20to%20get%20a%20free%20premium%20match.`
      ),
      Markup.button.callback("🔄 Refresh", "show_referral"),
    ])
  );
});

bot.action("show_referral", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.scene.leave();
  const telegramId = ctx.from.id;
  const user = await usersCollection.findOne({ telegramId });

  const referralMessage = `🎁 Referral Program 🎁

Your referral code: ${user.referralCode}
Your credits: ${user.referralCredits || 0}
People referred: ${user.referralCount || 0}`;

  const referralLink = `https://t.me/${
    (await bot.telegram.getMe()).username
  }?start=${user.referralCode}`;

  await ctx.reply(
    referralMessage,
    Markup.inlineKeyboard([
      Markup.button.url(
        "📤 Share Referral Link",
        `https://t.me/share/url?url=${encodeURIComponent(
          referralLink
        )}&text=Join%20me%20on%20this%20dating%20bot!%20Use%20my%20code%20${
          user.referralCode
        }%20to%20get%20a%20free%20premium%20match.`
      ),
      Markup.button.callback("🔄 Refresh", "show_referral"),
    ])
  );
});

// ===================== MESSAGE HANDLERS =====================
bot.action(/message_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const recipientId = parseInt(ctx.match[1]);
  ctx.session.conversationPartner = recipientId;
  await ctx.reply(`Type your message to send:`);
});

bot.on("text", async (ctx) => {
  if (ctx.session.conversationPartner) {
    await handleMessage(ctx, ctx.session.conversationPartner, ctx.message.text);
    ctx.session.conversationPartner = null;
  }
});

// ===================== FUN QUESTION HANDLER =====================
bot.action(/fun_question_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const partnerId = parseInt(ctx.match[1]);
  const questions = [
    "Would you rather have unlimited sushi for life or unlimited tacos for life?",
    "Would you rather be able to talk to animals or speak all foreign languages?",
    "Would you rather have a rewind button or a pause button in your life?",
    "Would you rather always be 10 minutes late or always be 20 minutes early?",
    "Would you rather lose all your money or all your pictures?",
  ];

  const randomQuestion =
    questions[Math.floor(Math.random() * questions.length)];
  wyrAnswers[ctx.from.id] = { question: randomQuestion, partnerId };

  await ctx.reply(
    `🤔 Would You Rather :\n\n${randomQuestion}`,
    Markup.inlineKeyboard([
      Markup.button.callback("Option A", "wyr_option_a"),
      Markup.button.callback("Option B", "wyr_option_b"),
    ])
  );
});

bot.action("wyr_option_a", async (ctx) => {
  await handleWyrAnswer(ctx, "A");
});

bot.action("wyr_option_b", async (ctx) => {
  await handleWyrAnswer(ctx, "B");
});

async function handleWyrAnswer(ctx, option) {
  const userId = ctx.from.id;
  const wyrData = wyrAnswers[userId];

  if (!wyrData) {
    await ctx.answerCbQuery("Question expired. Start a new one!");
    return;
  }

  const questionParts = wyrData.question.split(" or ");
  const answerText = option === "A" ? questionParts[0] : questionParts[1];

  await ctx.reply(`You chose: ${answerText}`);

  // Send answer to partner
  const user = await usersCollection.findOne({ telegramId: userId });
  await bot.telegram.sendMessage(
    wyrData.partnerId,
    `${user.name} answered your "Would You Rather" question:\n\n${wyrData.question}\n\nThey chose: ${answerText}`
  );

  delete wyrAnswers[userId];
}

// ===================== SHARE USERNAME HANDLER =====================
bot.action(/share_username_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const partnerId = parseInt(ctx.match[1]);

  const user = await usersCollection.findOne({ telegramId: userId });
  if (!user.username) {
    await ctx.reply("You don't have a Telegram username set in your profile.");
    return;
  }

  await bot.telegram.sendMessage(
    partnerId,
    `${user.name} (@${user.username}) has shared their username with you!`
  );

  await ctx.reply(`Your username @${user.username} has been shared.`);
});

// ===================== DISTANCE FILTER HANDLER =====================
bot.action("distance_filter", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "Set maximum distance for matches (in km):",
    Markup.keyboard([
      ["10 km", "25 km"],
      ["50 km", "100 km"],
      ["Any distance"],
      ["Cancel"],
    ]).oneTime()
  );
});

// ===================== ERROR HANDLING =====================
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType} update:`, err);
  if (ADMIN_IDS.length > 0) {
    bot.telegram.sendMessage(
      ADMIN_IDS[0],
      `Error in ${ctx.updateType}: ${err.message}\n\nUser: ${ctx.from.id}`
    );
  }
  return ctx.reply("An error occurred. Please try again.");
});

// ===================== START THE BOT =====================
async function startBot() {
  await connectDB();

  // Start photo reminder broadcast on a schedule
  setInterval(sendPhotoReminderBroadcast, 24 * 60 * 60 * 1000); // Daily

  await bot.launch();
  console.log("Bot started successfully");

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

startBot();
