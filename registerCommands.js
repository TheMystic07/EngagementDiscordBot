// registerCommands.js
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
require("dotenv").config();

const commands = [
  // ------------------ 1) VERIFY ------------------
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("🔗 Link your Twitter account")
    .addStringOption((opt) =>
      opt
        .setName("twitter_id")
        .setDescription("Your Twitter handle (without @)")
        .setRequired(true),
    ),

  // ------------------ 2) MYPOINTS ------------------
  new SlashCommandBuilder()
    .setName("mypoints")
    .setDescription("🔢 Check your current points"),

  // ------------------ 3) LEADERBOARD ------------------
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("🏆 Show the top 10 users by points"),

  // ------------------ 4) RESETPPOINTS ------------------
  new SlashCommandBuilder()
    .setName("resetpoints")
    .setDescription("🔄 Reset a user's points to 0 (admin only)")
    .addStringOption((opt) =>
      opt
        .setName("discord_id")
        .setDescription("The user's Discord ID")
        .setRequired(true),
    ),

  // ------------------ 5) SCOREHELP ------------------
  new SlashCommandBuilder()
    .setName("scorehelp")
    .setDescription("💡 Show how points are awarded"),

  // ------------------ 6) EDITSCORES ------------------
  new SlashCommandBuilder()
    .setName("editscores")
    .setDescription(
      "⚙️ Edit the point values for various actions (admin/mod only)",
    )
    .addStringOption((opt) =>
      opt
        .setName("key")
        .setDescription("Which scoring key to edit")
        .setRequired(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("value")
        .setDescription("The new numeric value")
        .setRequired(true),
    ),

  // ------------------ 7) SETREACTIONCHANNEL ------------------
  new SlashCommandBuilder()
    .setName("setreactionchannel")
    .setDescription("➕ Add a channel to the reaction-points list")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Which channel should give reaction points?")
        .setRequired(true),
    ),

  // ------------------ 8) REMOVEREACTIONCHANNEL ------------------
  new SlashCommandBuilder()
    .setName("removereactionchannel")
    .setDescription("➖ Remove a channel from the reaction-points list")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Which channel to remove?")
        .setRequired(true),
    ),

  // ------------------ 9) SETBOTLOGCHANNEL ------------------
  new SlashCommandBuilder()
    .setName("setbotlogchannel")
    .setDescription("📜 Set the channel for bot logs")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to send bot logs to")
        .setRequired(true),
    ),

  // ------------------ 10) TWEETERUPDATES ------------------
  new SlashCommandBuilder()
    .setName("tweeterupdates")
    .setDescription("🐦 Set the channel for new tweet announcements")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to announce new tweets")
        .setRequired(true),
    ),

  // ------------------ 11) NOTIFYTOGGLE ------------------
  new SlashCommandBuilder()
    .setName("notifytoggle")
    .setDescription(
      "🔕 Toggle whether the bot notifies you about earned points",
    ),

  // ------------------ 12) ADMINHELP ------------------
  new SlashCommandBuilder()
    .setName("adminhelp")
    .setDescription("🛠️ Shows a list of admin-only commands"),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Started refreshing global application (/) commands.");

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });

    console.log("Successfully reloaded global application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();
