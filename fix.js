// fix.js - Contains fixes for the wizard scene photo upload issues

module.exports = function (bot, usersCollection, showMainMenu) {
  // Fix for profile wizard photo step
  bot.on("photo", async (ctx, next) => {
    if (
      ctx.scene?.current?.id === "profile-wizard" &&
      ctx.scene.current.stepIndex === 5
    ) {
      // Photo step index
      ctx.message = ctx.message || {};
      ctx.message.text = "photo"; // Simulate text message for wizard
      return next();
    }
    return next();
  });

  // Fix for edit profile wizard photo step
  bot.on("photo", async (ctx, next) => {
    if (
      ctx.scene?.current?.id === "edit-profile-wizard" &&
      ctx.scene.current.stepIndex === 2 &&
      ctx.wizard?.state?.editField === "Photo"
    ) {
      ctx.message = ctx.message || {};
      ctx.message.text = "photo"; // Simulate text message for wizard
      return next();
    }
    return next();
  });

  console.log("Applied photo upload fixes for wizard scenes");
};
