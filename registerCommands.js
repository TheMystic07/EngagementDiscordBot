const { REST, Routes } = require("discord.js");
require("dotenv").config();

const commands = [
  {
    name: "verify",
    description: "Link your Twitter account to your Discord ID",
    options: [
      {
        name: "twitter_id",
        type: 3, // STRING
        description: "Your Twitter handle (without @)",
        required: true,
      },
    ],
  },
  {
    name: "mypoints",
    description: "Check your current points",
  },
  {
    name: "leaderboard",
    description: "View the top 10 users with the most points",
  },
  {
    name: "edit",
    description: "Admin: Edit points for a user",
    options: [
      {
        name: "discord_id",
        type: 3, // STRING
        description: "Discord ID of the user",
        required: true,
      },
      {
        name: "points",
        type: 4, // INTEGER
        description: "The new points value to set for the user",
        required: true,
      },
    ],
  },
  {
    name: "resetpoints",
    description: "Admin: Reset points for a user",
    options: [
      {
        name: "discord_id",
        type: 3, // STRING
        description: "Discord ID of the user whose points will be reset",
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Refreshing application commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Commands registered successfully.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
})();
