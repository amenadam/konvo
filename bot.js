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
    if (!ctx.message || (!ctx.message.photo && !ctx.message.text)) {
      await ctx.reply("Please upload a photo");
      return;
    }
    if (ctx.message.text && ctx.message.text !== "photo") {
      await ctx.reply("Please upload a photo, not text");
      return;
    }

    ctx.wizard.state.photo = ctx.message.photo[0].file_id;

    // Save profile to database
    const telegramId = ctx.from.id;
    const profile = {
      telegramId: ctx.from.id,
      name: ctx.wizard.state.name,
      age: ctx.wizard.state.age,
      gender: ctx.wizard.state.gender,
      interestedIn: ctx.wizard.state.interestedIn,
      bio: ctx.wizard.state.bio,
      photo: ctx.message.photo[0].file_id,
      city: ctx.wizard.state.city,
      location: ctx.wizard.state.location,
      active: true,
      registrationComplete: true,
      createdAt: new Date(),
      referralCredits:
        ctx.wizard.state.referralCredits ||
        ctx.scene.session.referralCredits ||
        0,
      referredBy:
        ctx.wizard.state.referredBy || ctx.scene.session.referredBy || null,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    };

    // Generate referral code if not exists
    if (!profile.referralCode) {
      profile.referralCode = `KONVO-${Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase()}`;
    }

    // Full profile update
    await usersCollection.updateOne(
      { telegramId: ctx.from.id },
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
      if (!ctx.message || (!ctx.message.photo && !ctx.message.text)) {
        await ctx.reply("Please upload a photo");
        return;
      }

      if (ctx.message.text && ctx.message.text !== "photo") {
        await ctx.reply("Please upload a photo, not text");
        return;
      }

      const update = { photo: ctx.message.photo[0].file_id };
      await usersCollection.updateOne(
        { telegramId: ctx.from.id },
        { $set: update }
      );

      await ctx.reply("Photo updated successfully!", Markup.removeKeyboard());
      await showMainMenu(ctx);
      return ctx.scene.leave();
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

const fix = require("./fix");
fix(bot, usersCollection, showMainMenu);

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
  let attempts = 0;
  const maxAttempts = 5;
  const retryDelay = 5000; // 5 seconds

  while (attempts < maxAttempts) {
    try {
      console.log(`Attempting MongoDB connection (attempt ${attempts + 1})`);
      await client.connect();

      // Verify connection
      await client.db().command({ ping: 1 });
      console.log("Successfully connected to MongoDB");

      db = client.db();
      usersCollection = db.collection("users");
      matchesCollection = db.collection("matches");
      conversationsCollection = db.collection("conversations");
      adminCollection = db.collection("admin");

      // Setup event listeners
      client.on("serverClosed", (event) => {
        console.log("MongoDB connection closed:", event);
        setTimeout(connectDB, retryDelay);
      });

      client.on("error", (err) => {
        console.log("MongoDB error:", err);
      });

      return; // Successfully connected
    } catch (err) {
      attempts++;
      console.log(`MongoDB connection attempt ${attempts} failed:`, err);

      if (attempts >= maxAttempts) {
        console.log("Max MongoDB connection attempts reached");
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}
async function removeBlockedUsers(bot) {
  try {
    const users = await usersCollection
      .find({}, { projection: { telegramId: 1 } })
      .toArray();
    let removedCount = 0;

    for (const user of users) {
      try {
        await bot.telegram.sendChatAction(user.telegramId, "typing");
      } catch (err) {
        if (err.response && err.response.error_code === 403) {
          // User blocked the bot or deactivated account
          await usersCollection.deleteOne({ telegramId: user.telegramId });
          removedCount++;
          console.log(`Removed blocked user: ${user.telegramId}`);
          if (ADMIN_IDS.length > 0) {
            await bot.telegram.sendMessage(
              ADMIN_IDS[0],
              `Removed blocked user: ${user.telegramId}`
            );
          }
        } else {
          console.error(
            `Error checking user ${user.telegramId}:`,
            err.description || err.message
          );
        }
      }
    }

    console.log(
      `Blocked users cleanup completed. Removed ${removedCount} users.`
    );
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Blocked users cleanup completed. Removed ${removedCount} users.`
      );
    }
  } catch (err) {
    console.error("Error in removeBlockedUsers:", err);
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
    }  liked your profile!`;

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

    // Add location/city filter if available
    if (user.city || user.location) {
      const locationConditions = [];

      // If user has city, match against city or location fields
      if (user.city) {
        const cleanCity = user.city
          .replace(/^(city|location):\s*/i, "")
          .trim()
          .toLowerCase();
        const cityRegex = new RegExp(
          `^(city|location):\\s*${cleanCity}|${cleanCity}$`,
          "i"
        );

        locationConditions.push(
          { city: { $regex: cityRegex } },
          { location: { $regex: cityRegex } }
        );
      }

      // If user has location, match against location or city fields
      if (user.location) {
        const cleanLocation = user.location
          .replace(/^(city|location):\s*/i, "")
          .trim()
          .toLowerCase();
        const locationRegex = new RegExp(
          `^(city|location):\\s*${cleanLocation}|${cleanLocation}$`,
          "i"
        );

        locationConditions.push(
          { location: { $regex: locationRegex } },
          { city: { $regex: locationRegex } }
        );
      }

      // Combine conditions with OR
      if (locationConditions.length > 0) {
        query.$or = locationConditions;
      }
    }

    const potentialMatch = await usersCollection.findOne(query);

    if (!potentialMatch) {
      // Try again without location filters
      if (user.city || user.location) {
        delete query.$or;
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

    // Find all matches where status is "matched" and not removed
    const matches = await matchesCollection
      .find({
        $or: [
          { telegramId1: telegramId, status: "matched" },
          { telegramId2: telegramId, status: "matched" },
        ],
        // Exclude matches where the user has been removed
        $and: [
          {
            $nor: [
              { telegramId1: telegramId, status: "removed" },
              { telegramId2: telegramId, status: "removed" },
            ],
          },
        ],
      })
      .toArray();

    if (matches.length === 0) {
      await ctx.reply("You don't have any matches yet. Keep searching!");
      return;
    }

    // Get all removed users to filter out
    const removedUsers = await matchesCollection
      .find({
        $or: [
          { telegramId1: telegramId, status: "removed" },
          { telegramId2: telegramId, status: "removed" },
        ],
      })
      .toArray();

    const removedIds = removedUsers.map((record) =>
      record.telegramId1 === telegramId
        ? record.telegramId2
        : record.telegramId1
    );

    for (const match of matches) {
      const matchId =
        match.telegramId1 === telegramId
          ? match.telegramId2
          : match.telegramId1;

      // Skip if this user is in the removed list
      if (removedIds.includes(matchId)) continue;

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
    if (user.location?.type === "Point" && match.location?.type === "Point") {
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

    // Helper function to safely get location string
    const getLocationString = (location) => {
      if (!location) return null;
      if (typeof location === "string") {
        return location
          .replace(/^(city|location):\s*/i, "")
          .trim()
          .toLowerCase();
      }
      return null;
    };

    const userCity = user.city
      ? user.city
          .replace(/^(city|location):\s*/i, "")
          .trim()
          .toLowerCase()
      : null;
    const userLocation = getLocationString(user.location);
    const matchCity = match.city
      ? match.city
          .replace(/^(city|location):\s*/i, "")
          .trim()
          .toLowerCase()
      : null;
    const matchLocation = getLocationString(match.location);

    // If either city or location matches (case insensitive)
    if (
      (userCity && matchCity && userCity === matchCity) ||
      (userCity && matchLocation && userCity === matchLocation) ||
      (userLocation && matchCity && userLocation === matchCity) ||
      (userLocation && matchLocation && userLocation === matchLocation)
    ) {
      score++;
    }
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
async function showProfilesForAdmin(ctx, user, index = 0) {
  try {
    // Get all users except admins
    const allUsers = await usersCollection
      .find({
        telegramId: { $nin: ADMIN_IDS },
      })
      .toArray();

    if (allUsers.length === 0) {
      return ctx.reply("No users found in database.");
    }

    // Handle index out of bounds
    if (index >= allUsers.length) index = 0;
    if (index < 0) index = allUsers.length - 1;

    const match = allUsers[index];
    const currentPosition = `${index + 1}/${allUsers.length}`;

    // Create admin-specific caption
    let caption = `👤 <b>User Profile</b> (${currentPosition})\n\n`;
    caption += `🆔 ID: <code>${match.telegramId}</code>\n`;
    caption += `👤 Name: ${match.name || "Unknown"}\n`;
    caption += `🎂 Age: ${match.age || "Not specified"}\n`;
    caption += `⚧️ Gender: ${match.gender || "Not specified"}\n`;
    caption += `📍 Location: ${
      match.city || match.location || "Not specified"
    }\n`;
    caption += `📝 Bio: ${match.bio || "No bio provided"}\n`;
    caption += `🔍 Interested in: ${match.interestedIn || "Not specified"}\n`;
    caption += `🔄 Last active: ${
      match.lastActive ? new Date(match.lastActive).toLocaleString() : "Unknown"
    }\n`;
    caption += `✅ Verified: ${match.verified ? "Yes" : "No"}\n`;
    caption += `🚦 Status: ${match.active ? "Active" : "Inactive"}`;

    // Create admin keyboard with navigation and actions
    const keyboard = [
      [
        Markup.button.callback("⬅️ Previous", `admin_prev_${index}`),
        Markup.button.callback("➡️ Next", `admin_next_${index}`),
      ],
      [
        Markup.button.callback("✉️ Message", `admin_msg_${match.telegramId}`),
        Markup.button.callback(
          match.active ? "❌ Deactivate" : "✅ Activate",
          `admin_toggle_${match.telegramId}`
        ),
      ],
      [
        Markup.button.callback("🚫 Ban User", `admin_ban_${match.telegramId}`),
        Markup.button.callback("🔄 Refresh", `admin_refresh_${index}`),
      ],
      [Markup.button.callback("🔙 Back to Menu", "admin_menu")],
    ];

    // Check if user has a custom photo or is using default
    const hasCustomPhoto =
      match.photo && match.photo !== process.env.DEFAULT_PROFILE_PHOTO;
    const isFileId =
      match.photo && /^[A-Za-z0-9_-]+$/.test(match.photo.split(":")[0]);

    if (!hasCustomPhoto) {
      // No custom photo - just send text with "NO PROFILE PHOTO"
      caption = `🚫 NO PROFILE PHOTO\n\n${caption}`;
      if (ctx.update.callback_query) {
        await ctx.editMessageText(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } else {
        await ctx.reply(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    } else if (isFileId) {
      // Has a custom photo (Telegram file ID) - indicate photo exists but don't send it
      caption = `✅ PROFILE PHOTO UPLOADED\n\n${caption}`;
      if (ctx.update.callback_query) {
        await ctx.editMessageText(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } else {
        await ctx.reply(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    } else {
      // Has a custom photo (URL) - you can choose to handle this differently if needed
      caption = `🌐 PROFILE PHOTO (URL)\n\n${caption}`;
      if (ctx.update.callback_query) {
        await ctx.editMessageText(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      } else {
        await ctx.reply(caption, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    }

    // Store current index in session for navigation
    ctx.session.adminCurrentIndex = index;
    ctx.session.adminUserList = allUsers.map((u) => u.telegramId);
  } catch (error) {
    console.error("Error in showProfilesForAdmin:", error);
    await ctx.reply("Couldn't load user profiles. Please try again.");
    if (ADMIN_IDS.includes(ctx.from.id)) {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        `Admin error in showProfilesForAdmin: ${error.message}`
      );
    }
  }
}

async function handleAdminMessageUser(ctx) {
  try {
    const userId = ctx.match[1];
    ctx.session.adminMessageTarget = userId;

    await ctx.reply(
      `Enter the message you want to send to user ${userId}:`,
      Markup.keyboard([["Cancel"]]).resize()
    );

    ctx.session.adminWaitingForMessage = true;
  } catch (error) {
    console.error("Error in handleAdminMessageUser:", error);
    await ctx.reply("Error preparing message. Please try again.");
  }
}

// Add these to your bot action handlers

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
          ["🔙 User Menu", "All Users"],
          ["🔍 Find Match", "💌 My Matches"],
        ["👤 My Profile", "✏️ Edit Profile"],
        ["❤️ Who Liked Me", "🎁 Referral Program"],
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
      `New message from ${sender.name}:\n\n${text}`,
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
    await removeBlockedUsers(bot);
    const totalUsers = await usersCollection.countDocuments();
    const activeUsers = await usersCollection.countDocuments({ active: true });
    const maleUsers = await usersCollection.countDocuments({
      gender: { $in: ["Male", "male"] },
    });

    const femaleUsers = await usersCollection.countDocuments({
      gender: { $in: ["Female", "female"] },
    });
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

male users: ${maleUsers}
Female users: ${femaleUsers}
    
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

    const existingUser = await usersCollection.findOne({
      telegramId: ctx.from.id,
    });

    if (!existingUser) {
      // Create temporary user data with referral info
      const tempUserData = {
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        createdAt: new Date(),
        active: false, // Not active until profile complete
        registrationComplete: false,
        referralCredits: referrer ? 1 : 0,
        referredBy: referrer?.telegramId || null,
      };

      // Store temporary data
      await usersCollection.insertOne(tempUserData);

      // Handle referral notifications
      if (referrer) {
        await usersCollection.updateOne(
          { telegramId: referrer.telegramId },
          {
            $inc: { referralCount: 1, referralCredits: 1 },
            $set: { lastReferralAt: new Date() },
          }
        );

        await ctx.reply(
          `🎉 You joined using ${referrer.name}'s referral link! You've received 1 premium match credit.`
        );
        await bot.telegram.sendMessage(
          referrer.telegramId,
          `🎊 ${ctx.from.first_name} joined using your referral link! You've earned 1 premium match credit.`
        );
      }

      // Enter profile wizard with referral credits preserved
      return ctx.scene.enter("profile-wizard", {
        referralCredits: tempUserData.referralCredits,
        referredBy: tempUserData.referredBy,
      });
    } else if (!existingUser.registrationComplete) {
      // Continue registration if incomplete
      return ctx.scene.enter("profile-wizard", {
        referralCredits: existingUser.referralCredits,
        referredBy: existingUser.referredBy,
      });
    }

    // For registered users
    await ctx.reply(`Welcome back, ${existingUser.name}!`);
    await showMainMenu(ctx);
  } catch (error) {
    console.error("Start command error:", error);
    await ctx.reply("Error starting the bot. Please try again.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Start error for ${ctx.from.id}: ${error.message}`
      );
    }
  }
});
bot.command("version", (ctx) => {
  ctx.reply(`🤖 Bot version: v${version}`);
});
bot.command("remind", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply("You are not authorized to send remind broadcasts.");
    return;
  }
  await sendPhotoReminderBroadcast();
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

bot.hears("All Users", async (ctx) => {
  try {
    if (!ADMIN_IDS.includes(ctx.from.id)) {
      await ctx.reply("❌ You are not authorized to use this command.");
      return;
    }

    // Send loading message
    const loadingMsg = await ctx.reply("⏳ Loading user profiles...");

    // Initialize session if it doesn't exist
    if (!ctx.session.admin) {
      ctx.session.admin = {};
    }

    // Start from the first user
    await showProfilesForAdmin(ctx, ctx.from, 0);

    // Delete loading message
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
  } catch (error) {
    console.error("Error in All Users command:", error);
    await ctx.reply("❌ Failed to load user profiles. Please try again.");

    // Notify main admin about the error
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in All Users command by ${ctx.from.id}: ${error.message}`
      );
    }
  }
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
  try {
    const telegramId = ctx.from.id;

    // First get all users I've removed
    const myRemovedUsers = await matchesCollection
      .find({
        telegramId1: telegramId,
        status: "removed",
      })
      .toArray();
    const removedIds = myRemovedUsers.map((u) => u.telegramId2);

    // Find users who liked me but I haven't liked/disliked/removed them yet
    const pendingLikes = await matchesCollection
      .find({
        telegramId2: telegramId,
        status: "pending",
        telegramId1: { $nin: removedIds }, // Exclude removed users
      })
      .toArray();

    if (pendingLikes.length === 0) {
      await ctx.reply("No one has liked you yet. Keep searching!");
      return;
    }

    const likerIds = pendingLikes.map((m) => m.telegramId1);
    const likers = await usersCollection
      .find({
        telegramId: { $in: likerIds },
        active: true,
      })
      .toArray();

    if (likers.length === 0) {
      await ctx.reply("No active users have liked you yet.");
      return;
    }

    for (const liker of likers) {
      await ctx.replyWithPhoto(
        liker.photo || process.env.DEFAULT_PROFILE_PHOTO,
        {
          caption: `Name: ${liker.name}\nAge: ${liker.age}\nGender: ${
            liker.gender
          }\nBio: ${liker.bio || "No bio provided"}`,
          ...Markup.inlineKeyboard([
            Markup.button.callback("👍 Like Back", `like_${liker.telegramId}`),
            Markup.button.callback("👎 Dislike", `dislike_${liker.telegramId}`),
            Markup.button.callback("🚫 Remove", `remove_${liker.telegramId}`),
          ]),
        }
      );
    }
  } catch (error) {
    console.error("Error in Who Liked Me:", error);
    await ctx.reply("An error occurred while loading who liked you.");
    if (ADMIN_IDS.length > 0) {
      await bot.telegram.sendMessage(
        ADMIN_IDS[0],
        `Error in Who Liked Me for ${ctx.from.id}: ${error.message}`
      );
    }
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

    // Check if they're currently matched
    const existingMatch = await matchesCollection.findOne({
      $or: [
        { telegramId1: removerId, telegramId2: removedId },
        { telegramId1: removedId, telegramId2: removerId },
      ],
      status: { $in: ["matched", "pending"] },
    });

    if (existingMatch) {
      // Update the existing match record to "removed" status
      await matchesCollection.updateOne(
        { _id: existingMatch._id },
        { $set: { status: "removed" } }
      );
    } else {
      // Create a new removal record
      await matchesCollection.insertOne({
        telegramId1: removerId,
        telegramId2: removedId,
        status: "removed",
        createdAt: new Date(),
      });
    }

    await ctx.reply(
      "This user has been removed from your matches and won't appear again."
    );

    // Safely attempt to delete the message
    try {
      await ctx.deleteMessage();
    } catch (deleteError) {
      console.log("Could not delete message:", deleteError.message);
    }

    // Determine where to go next based on the context
    const callbackMessage = ctx.callbackQuery?.message;
    const isFromMatchesList =
      callbackMessage?.caption?.includes("Your Matches") ||
      callbackMessage?.text?.includes("Your Matches");

    if (isFromMatchesList) {
      await showMatches(ctx);
    } else {
      await findMatch(ctx);
    }
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


const wyrQuestions = [
  {
    question: "Would you rather go on a cozy movie night 🍿 or a fancy dinner date 🍷?",
    options: ["Movie Night", "Fancy Dinner"],
  },
  {
    question: "Would you rather receive a surprise gift 🎁 or a surprise kiss 💋?",
    options: ["Gift", "Kiss"],
  },
  {
    question: "Would you rather travel the world together 🌍 or build a dream home 🏡?",
    options: ["Travel", "Dream Home"],
  },
  {
    question: "Would you rather cuddle all night 🛌 or go on a late-night adventure 🌙?",
    options: ["Cuddle", "Adventure"],
  },
  {
    question: "Would you rather share your favorite playlist 🎶 or cook your favorite meal 🍲 for each other?",
    options: ["Playlist", "Meal"],
  },
  {
    question: "Would you rather spend a rainy day ☔ reading together or dancing in the rain 💃?",
    options: ["Reading", "Dancing"],
  },
  {
    question: "Would you rather kiss under the stars ✨ or in the rain 🌧️?",
    options: ["Stars", "Rain"],
  },
  {
    question: "Would you rather plan a surprise date 🎭 or be surprised by your partner 🎉?",
    options: ["Plan", "Be Surprised"],
  },
  {
    question: "Would you rather hold hands while walking 🚶‍♂️ or hug every few minutes 🤗?",
    options: ["Hold Hands", "Hug Often"],
  },
  {
    question: "Would you rather spend a weekend in the mountains 🏔️ or on the beach 🏖️?",
    options: ["Mountains", "Beach"],
  },
  {
    question: "Would you rather dance slowly to a romantic song 🎶 or sing karaoke loudly together 🎤?",
    options: ["Slow Dance", "Karaoke"],
  },
  {
    question: "Would you rather share one dessert 🍰 or order two different ones 🍨?",
    options: ["Share One", "Two Desserts"],
  },
  {
    question: "Would you rather send long love texts 💌 or have late-night phone calls 📞?",
    options: ["Love Texts", "Phone Calls"],
  },
  {
    question: "Would you rather have a matching couple outfit 👕 or matching couple tattoos 💉?",
    options: ["Outfit", "Tattoos"],
  },
  {
    question: "Would you rather be each other’s first love ❤️ or last love 💍?",
    options: ["First Love", "Last Love"],
  },
  {
    question: "Would you rather play video games together 🎮 or binge-watch a series 📺?",
    options: ["Video Games", "Series"],
  },
  {
    question: "Would you rather kiss good morning 🌅 or kiss good night 🌙?",
    options: ["Morning Kiss", "Night Kiss"],
  },
  {
    question: "Would you rather laugh until your stomach hurts 😂 or talk until sunrise 🌄?",
    options: ["Laugh", "Talk"],
  },
  {
    question: "Would you rather write each other love letters ✍️ or make silly voice notes 🎙️?",
    options: ["Love Letters", "Voice Notes"],
  },
  {
    question: "Would you rather cook dinner together 🍝 or order takeout and relax 🍕?",
    options: ["Cook Together", "Order Takeout"],
  },
];


//compatibility scores
let compatibilityScores = {}; // cumulative scores per couple

function getCoupleKey(user1, user2) {
  return [user1, user2].sort().join("_"); // ensures same key regardless of order
}

// Start a fun question
bot.action(/fun_question_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const partnerId = parseInt(ctx.match[1]);

  const randomQ = wyrQuestions[Math.floor(Math.random() * wyrQuestions.length)];
  wyrAnswers[ctx.from.id] = { question: randomQ, partnerId };

  await ctx.reply(
    `💞 Would You Rather:\n\n${randomQ.question}`,
    Markup.inlineKeyboard([
      Markup.button.callback(`👉 ${randomQ.options[0]}`, "wyr_option_a"),
      Markup.button.callback(`👉 ${randomQ.options[1]}`, "wyr_option_b"),
    ])
  );
});

// Handle answers
bot.action(["wyr_option_a", "wyr_option_b"], async (ctx) => {
  const userId = ctx.from.id;
  const answer = ctx.callbackQuery.data === "wyr_option_a" ? "A" : "B";
  const userData = wyrAnswers[userId];

  if (!userData) return ctx.answerCbQuery("No question found 😅");

  // Save the answer
  userData.answer = answer;
  await ctx.answerCbQuery("Answer saved ✅");

  // Check if partner answered too
  const partnerData = wyrAnswers[userData.partnerId];
  if (
    partnerData &&
    partnerData.question.question === userData.question.question &&
    partnerData.answer
  ) {
    const coupleKey = getCoupleKey(userId, userData.partnerId);

    // Check if answers match
    const match =
      partnerData.answer === userData.answer
        ? "💘 You both matched!"
        : "😅 Different choices this time.";

    // Update compatibility score
    if (!compatibilityScores[coupleKey]) compatibilityScores[coupleKey] = 0;
    if (partnerData.answer === userData.answer) {
      compatibilityScores[coupleKey] += 1;
    }

    const score = compatibilityScores[coupleKey];

    await ctx.reply(
      `✨ Results for: *${userData.question.question}*\n\n` +
        `You chose: *${
          userData.answer === "A"
            ? userData.question.options[0]
            : userData.question.options[1]
        }*\n` +
        `Your partner chose: *${
          partnerData.answer === "A"
            ? partnerData.question.options[0]
            : partnerData.question.options[1]
        }*\n\n` +
        `${match}\n\n💞 Compatibility Score: *${score}*`,
      { parse_mode: "Markdown" }
    );

    delete wyrAnswers[userId];
    delete wyrAnswers[userData.partnerId];
  }
});

// Command to check compatibility score
bot.command("compatibility", async (ctx) => {
  const userId = ctx.from.id;

  // Try to find couple score
  const coupleKey = Object.keys(compatibilityScores).find((key) =>
    key.includes(userId.toString())
  );

  if (!coupleKey) {
    return ctx.reply("💔 You don’t have a recorded compatibility score yet. Play more Would You Rather!");
  }

  const score = compatibilityScores[coupleKey];
  await ctx.reply(
    `💞 Your current compatibility score with your partner is: *${score}*`,
    { parse_mode: "Markdown" }
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

  // Get username directly from the chat context instead of database
  const username = ctx.from.username;
  if (!username) {
    await ctx.reply("You don't have a Telegram username set in your profile.");
    return;
  }

  // Get name from context if available, otherwise use first_name
  const name = ctx.from.first_name || "User";

  await bot.telegram.sendMessage(
    partnerId,
    `${name} (@${username}) has shared their username with you!`
  );

  await ctx.reply(`Your username @${username} has been shared.`);
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
bot.action(/admin_prev_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1]) - 1;
  await showProfilesForAdmin(ctx, ctx.from, index);
});

bot.action(/admin_next_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1]) + 1;
  await showProfilesForAdmin(ctx, ctx.from, index);
});

bot.action(/admin_msg_(\d+)/, handleAdminMessageUser);

bot.action(/admin_toggle_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  const user = await usersCollection.findOne({ telegramId: userId });
  await usersCollection.updateOne(
    { telegramId: userId },
    { $set: { active: !user.active } }
  );
  await ctx.answerCbQuery(`User ${user.active ? "deactivated" : "activated"}`);
  await showProfilesForAdmin(ctx, ctx.from, ctx.session.adminCurrentIndex);
});

bot.action(/admin_ban_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  await usersCollection.updateOne(
    { telegramId: userId },
    { $set: { banned: true, active: false } }
  );
  await ctx.answerCbQuery("User banned successfully");
  await showProfilesForAdmin(ctx, ctx.from, ctx.session.adminCurrentIndex);
});

bot.action(/admin_refresh_(\d+)/, async (ctx) => {
  await showProfilesForAdmin(ctx, ctx.from, parseInt(ctx.match[1]));
});

// Handle the actual message sending
bot.on("text", async (ctx) => {
  if (ctx.session.adminWaitingForMessage) {
    if (ctx.message.text.toLowerCase() === "cancel") {
      delete ctx.session.adminWaitingForMessage;
      delete ctx.session.adminMessageTarget;
      await ctx.reply("Message cancelled", Markup.removeKeyboard());
      return;
    }

    try {
      await ctx.telegram.sendMessage(
        ctx.session.adminMessageTarget,
        `📨 Message from admin:\n\n${ctx.message.text}`
      );
      await ctx.reply("Message sent successfully!", Markup.removeKeyboard());
    } catch (error) {
      await ctx.reply(`Failed to send message: ${error.message}`);
    }

    delete ctx.session.adminWaitingForMessage;
    delete ctx.session.adminMessageTarget;
  }
});
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
      // await ctx.answerCbQuery("Liked");
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


function startBroadcast(usersCollection) {
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



// ===================== START THE BOT =====================
async function startBot() {
  try {
    console.log("Connecting to MongoDB...");
    await connectDB(); // this sets usersCollection globally

    console.log("Starting bot...");
    await bot.launch();

    // Use global usersCollection
    startBroadcast(usersCollection);

    console.log("Setting bot commands...");
    await bot.telegram.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show help" },
      { command: "version", description: "Show bot version" },
    ]);

    // Ping the bot to verify it's running
    try {
      const me = await bot.telegram.getMe();
      console.log(`✅ Bot @${me.username} is running`);
    } catch (pingError) {
      console.error("❌ Bot failed to respond to getMe:", pingError);
    }

    // Graceful shutdown
    process.once("SIGINT", () => {
      console.log("SIGINT received, shutting down gracefully...");
      bot.stop("SIGINT");
      process.exit(0);
    });

    process.once("SIGTERM", () => {
      console.log("SIGTERM received, shutting down gracefully...");
      bot.stop("SIGTERM");
      process.exit(0);
    });

    // Keep-alive check every 5 minutes
    setInterval(async () => {
      try {
        await bot.telegram.getMe();
      } catch (err) {
        console.error("Keep-alive check failed:", err);
        try {
          await bot.launch();
          console.log("Bot restarted after keep-alive failure");
        } catch (restartError) {
          console.error("Failed to restart bot:", restartError);
        }
      }
    }, 300000); // 5 minutes
  } catch (error) {
    console.error("❌ Failed to start bot: ", error);
    process.exit(1);
  }
}

startBot();

