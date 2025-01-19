const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const { TwitterApi } = require("twitter-api-v2");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);
const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);

// Track user message counts
const messageCounts = {};

// Utility to update points
async function updatePoints(discordId, points) {
  console.log(`[updatePoints] Updating points for Discord ID: ${discordId}`);
  let { data, error } = await supabase
    .from("users")
    .select("points")
    .eq("discord_id", discordId)
    .single();

  if (error)
    console.error(`[updatePoints] Error fetching user: ${error.message}`);

  if (data) {
    const newPoints = data.points + points;
    await supabase
      .from("users")
      .update({ points: newPoints })
      .eq("discord_id", discordId);
    return newPoints;
  } else {
    await supabase.from("users").insert([{ discord_id: discordId, points }]);
    return points;
  }
}

// Command Handlers
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options, user } = interaction;

  if (commandName === "verify") {
    const twitterId = options.getString("twitter_id");
    const { error } = await supabase
      .from("users")
      .upsert([{ discord_id: user.id, twitter_id: twitterId }]);

    if (error) {
      await interaction.reply(
        "⚠️ Something went wrong while linking your Twitter account. Please try again.",
      );
    } else {
      await interaction.reply(
        `✅ Your Twitter account \`${twitterId}\` has been successfully linked!`,
      );
    }
  } else if (commandName === "mypoints") {
    const { data, error } = await supabase
      .from("users")
      .select("points")
      .eq("discord_id", user.id)
      .single();

    if (error) {
      await interaction.reply(
        "❌ Error fetching your points. Please try again later.",
      );
    } else if (data) {
      await interaction.reply(
        `🎉 You currently have **${data.points} points**! Keep up the great work!`,
      );
    } else {
      await interaction.reply(
        "😕 You have no points yet. Start interacting to earn points!",
      );
    }
  } else if (commandName === "leaderboard") {
    const { data, error } = await supabase
      .from("users")
      .select("discord_id, points")
      .order("points", { ascending: false })
      .limit(10);

    if (error) {
      await interaction.reply(
        "❌ Error fetching the leaderboard. Please try again later.",
      );
    } else {
      const leaderboard = data
        .map(
          (entry, index) =>
            `${index + 1}. <@${entry.discord_id}> - **${entry.points} points**`,
        )
        .join("\n");
      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("🏆 Leaderboard")
        .setDescription(leaderboard || "No data available.");

      await interaction.reply({ embeds: [embed] });
    }
  } else if (commandName === "resetpoints") {
    const admin = interaction.member.permissions.has("ADMINISTRATOR");
    if (!admin) {
      return interaction.reply("🚫 Only admins can use this command.");
    }

    const targetId = options.getString("discord_id");
    const { error } = await supabase
      .from("users")
      .update({ points: 0 })
      .eq("discord_id", targetId);

    if (error) {
      await interaction.reply("❌ Error resetting points. Please try again.");
    } else {
      await interaction.reply(
        `✅ Points for user <@${targetId}> have been reset.`,
      );
    }
  }
});

// Event Handlers
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!messageCounts[message.author.id]) messageCounts[message.author.id] = 0;
  messageCounts[message.author.id] += 1;

  if (messageCounts[message.author.id] >= 5) {
    const newPoints = await updatePoints(message.author.id, 10);
    messageCounts[message.author.id] = 0;
    console.log(`[messageCreate] User ${message.author.tag} earned 10 points.`);
    message.reply(
      `🎉 You earned **10 points**! Your total is now **${newPoints} points**.`,
    );
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  const newPoints = await updatePoints(user.id, 5);
  console.log(`[messageReactionAdd] User ${user.tag} earned 5 points.`);
});

// Twitter Actions (Poll for User Engagement)
async function checkTwitterActivity() {
  console.log("[checkTwitterActivity] Polling Twitter for user activity...");
  const { data: users, error } = await supabase
    .from("users")
    .select("twitter_id, discord_id");

  if (error) {
    console.error(
      `[checkTwitterActivity] Error fetching users: ${error.message}`,
    );
    return;
  }

  const account = await twitterClient.v2.userByUsername(
    process.env.TWITTER_ACCOUNT,
  );
  const tweets = await twitterClient.v2.userTimeline(account.data.twitter_id, {
    max_results: 5,
  });

  for (const user of users) {
    const twitterId = user.twitter_id;
    for (const tweet of tweets.data) {
      const likes = await twitterClient.v2.tweetLikedBy(tweet.id);
      const retweets = await twitterClient.v2.tweetRetweetedBy(tweet.id);

      if (likes.data.some((like) => like.id === twitterId)) {
        await updatePoints(user.discord_id, 10);
        console.log(
          `[Twitter] User ${user.discord_id} liked a tweet and earned 10 points.`,
        );
      }
      if (retweets.data.some((retweet) => retweet.id === twitterId)) {
        await updatePoints(user.discord_id, 10);
        console.log(
          `[Twitter] User ${user.discord_id} retweeted and earned 10 points.`,
        );
      }
    }
  }
}

// Bot Login
client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log("[Bot] Bot logged in successfully.");
});

// Poll Twitter every 10 minutes
setInterval(checkTwitterActivity, 6000);
