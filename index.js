/********************************************************************
 *                         IMPORTS & SETUP
 ********************************************************************/
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const { TwitterApi } = require("twitter-api-v2");
require("dotenv").config();

// Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// Twitter Client
const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
const OFFICIAL_TWITTER_ACCOUNT = process.env.TWITTER_ACCOUNT;

/********************************************************************
 *         TRACKERS & IN-MEMORY CONFIG
 ********************************************************************/

// For message points, we track how many messages each user has sent today,
// how many points they've earned from messages so far today, etc.
const dailyMessageTracker = {};
// Structure: dailyMessageTracker[discordId] = {
//   date: "YYYY-MM-DD",
//   messagesSoFar: number,
//   pointsEarnedToday: number
// };

// Reaction channels in memory
let REACTION_CHANNELS = [];

// Bot log channel ID
let BOT_LOG_CHANNEL = null;

// Tweet updates channel ID
let TWEET_UPDATES_CHANNEL = null;

/**
 * Scoring config from your new rules:
 *  - 1 point per 5 messages (max 20 points / day)
 *  - Reactions: 2 points
 *  - Connect Wallet: 10 points
 *  - Like: 4 points
 *  - Retweet: 7 points
 *  - Quote Retweet: 10 points
 *  - Reply: 8 points
 */
const SCORE_CONFIG = {
  // For messages, we do not directly store "1 point per 5" here,
  // we’ll do the logic in code.
  messagesPerPoint: 5,
  messageMaxPointsPerDay: 20,

  reactionPoints: 2,
  connectWalletPoints: 10,

  likePoints: 4,
  retweetPoints: 7,
  quoteRetweetPoints: 10,
  replyPoints: 8,
};

/********************************************************************
 *                      LOGGING HELPERS
 ********************************************************************/

/**
 * Logs a message to console AND optionally to the configured bot log channel.
 */
async function botLog(msg) {
  console.log("[LOG]", msg);
  if (!BOT_LOG_CHANNEL) return;
  try {
    const channel = await client.channels.fetch(BOT_LOG_CHANNEL);
    if (channel) {
      channel.send(msg);
    }
  } catch (err) {
    console.error(`[botLog] Error sending to BOT_LOG_CHANNEL: ${err}`);
  }
}

/********************************************************************
 *             ACTIVITY LOGS & ADMIN LOGS (DB Insert)
 ********************************************************************/

/**
 * Log normal user point awards to "activity_logs".
 * e.g. action = "message_points", "reaction_points", "twitter_like", ...
 */
async function logActivity(discordId, action, points) {
  const { error } = await supabase.from("activity_logs").insert([
    {
      discord_id: discordId,
      action,
      points,
    },
  ]);
  if (error) {
    botLog(
      `[logActivity] Error logging activity for ${discordId}: ${error.message}`,
    );
  } else {
    botLog(
      `[logActivity] Logged ${points} points for ${discordId} (${action}).`,
    );
  }
}

/**
 * Log admin actions to "admin_logs".
 * e.g. action = "resetpoints", "editscores", ...
 * pointsChanged can be positive or negative.
 */
async function logAdminAction(adminId, userId, action, pointsChanged = null) {
  const { error } = await supabase.from("admin_logs").insert([
    {
      admin_id: adminId,
      user_id: userId,
      action,
      points_changed: pointsChanged,
    },
  ]);
  if (error) {
    botLog(`[logAdminAction] Error logging admin action: ${error.message}`);
  } else {
    botLog(
      `[logAdminAction] Admin ${adminId} -> ${action} for user ${userId}, points_changed=${pointsChanged}`,
    );
  }
}

/********************************************************************
 *      LOAD REACTION CHANNELS
 ********************************************************************/

async function loadReactionChannels() {
  const { data, error } = await supabase
    .from("reaction_channels")
    .select("channel_id");
  if (error) {
    botLog(`[loadReactionChannels] Error: ${error.message}`);
    return;
  }
  if (!data) return;
  REACTION_CHANNELS = data.map((row) => row.channel_id);
  botLog(
    `[loadReactionChannels] Loaded reaction channels: ${REACTION_CHANNELS}`,
  );
}

async function addReactionChannel(channelId) {
  const { error } = await supabase
    .from("reaction_channels")
    .insert([{ channel_id: channelId }]);
  if (error) {
    botLog(`[addReactionChannel] Error: ${error.message}`);
    return false;
  }
  REACTION_CHANNELS.push(channelId);
  botLog(`[addReactionChannel] Channel ${channelId} added.`);
  return true;
}

async function removeReactionChannel(channelId) {
  const { error } = await supabase
    .from("reaction_channels")
    .delete()
    .eq("channel_id", channelId);
  if (error) {
    botLog(`[removeReactionChannel] Error: ${error.message}`);
    return false;
  }
  REACTION_CHANNELS = REACTION_CHANNELS.filter((id) => id !== channelId);
  botLog(`[removeReactionChannel] Channel ${channelId} removed.`);
  return true;
}

/********************************************************************
 *                UPDATE POINTS & LOG ACTIVITY
 ********************************************************************/

/**
 * A generic function to update user’s points if they’re verified,
 * log the action, and respect the user’s notification setting.
 */
async function awardPoints(discordId, pointsToAdd, action) {
  // 1. Fetch user
  const { data: userData, error } = await supabase
    .from("users")
    .select("points, twitter_id, notify_enabled")
    .eq("discord_id", discordId)
    .single();

  if (error || !userData) {
    return { newPoints: null, notifyEnabled: true, verified: false };
  }
  if (!userData.twitter_id) {
    // Not verified
    return { newPoints: null, notifyEnabled: true, verified: false };
  }

  // 2. Update points
  const oldPoints = userData.points || 0;
  const newPoints = oldPoints + pointsToAdd;

  const { error: updateErr } = await supabase
    .from("users")
    .update({ points: newPoints })
    .eq("discord_id", discordId);

  if (updateErr) {
    botLog(
      `[awardPoints] Error updating user ${discordId}: ${updateErr.message}`,
    );
    return { newPoints: null, notifyEnabled: true, verified: true };
  }

  // 3. Log
  if (pointsToAdd !== 0) {
    await logActivity(discordId, action, pointsToAdd);
  }

  return {
    newPoints,
    notifyEnabled: userData.notify_enabled,
    verified: true,
  };
}

/********************************************************************
 *                       SLASH COMMAND HANDLER
 ********************************************************************/
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, options, user, member } = interaction;

  // ---- /verify ----
  if (commandName === "verify") {
    const twitterId = options.getString("twitter_id");
    const { error } = await supabase
      .from("users")
      .upsert([{ discord_id: user.id, twitter_id: twitterId }], {
        onConflict: "discord_id",
      });

    if (error) {
      return interaction.reply({
        content: "⚠️ Error linking your Twitter. Please try again.",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `✅ Linked Twitter account \`${twitterId}\`!`,
      ephemeral: true,
    });
  }

  // ---- /mypoints ----
  else if (commandName === "mypoints") {
    const { data, error } = await supabase
      .from("users")
      .select("points")
      .eq("discord_id", user.id)
      .single();

    if (error) {
      return interaction.reply({
        content: "❌ Error fetching points.",
        ephemeral: true,
      });
    }
    if (!data) {
      return interaction.reply({
        content: "😕 You have no points yet. /verify to start earning!",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `You have **${data.points}** points!`,
      ephemeral: true,
    });
  }

  // ---- /leaderboard (public) ----
  else if (commandName === "leaderboard") {
    const { data, error } = await supabase
      .from("users")
      .select("discord_id, points")
      .order("points", { ascending: false })
      .limit(10);

    if (error) {
      return interaction.reply("❌ Error fetching leaderboard.");
    }

    const leaderboard = data
      .map((u, i) => `${i + 1}. <@${u.discord_id}> - **${u.points} points**`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor("#FFD700")
      .setTitle("🏆 Leaderboard")
      .setDescription(leaderboard || "No data.");

    return interaction.reply({ embeds: [embed] });
  }

  // ---- /resetpoints (admin) ----
  else if (commandName === "resetpoints") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Admin only.",
        ephemeral: true,
      });
    }

    const targetId = options.getString("discord_id");
    // fetch old points
    const { data: oldData, error: oldErr } = await supabase
      .from("users")
      .select("points")
      .eq("discord_id", targetId)
      .single();

    if (oldErr || !oldData) {
      return interaction.reply({
        content: "❌ That user doesn't exist or wasn't found.",
        ephemeral: true,
      });
    }

    const oldPoints = oldData.points;

    const { error: updErr } = await supabase
      .from("users")
      .update({ points: 0 })
      .eq("discord_id", targetId);

    if (updErr) {
      return interaction.reply({
        content: "❌ Could not reset points.",
        ephemeral: true,
      });
    }
    // Log admin
    await logAdminAction(user.id, targetId, "resetpoints", -oldPoints);

    return interaction.reply({
      content: `✅ Reset points for <@${targetId}>.`,
      ephemeral: true,
    });
  }

  // ---- /scorehelp ----
  else if (commandName === "scorehelp") {
    const helpMsg = `
**Scoring Rules:**
• **Messages**: 1 point per 5 messages, up to 20 pts/day
• **Reactions (Announcements)**: ${SCORE_CONFIG.reactionPoints} points
• **Connect Wallet**: ${SCORE_CONFIG.connectWalletPoints} points
• **Like (X)**: ${SCORE_CONFIG.likePoints} points
• **Retweet (X)**: ${SCORE_CONFIG.retweetPoints} points
• **Quote Retweet (X)**: ${SCORE_CONFIG.quoteRetweetPoints} points
• **Reply (X)**: ${SCORE_CONFIG.replyPoints} points
`;
    return interaction.reply({ content: helpMsg, ephemeral: true });
  }

  // ---- /editscores (admin/mod) ----
  else if (commandName === "editscores") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only admins or mods.",
        ephemeral: true,
      });
    }

    const key = options.getString("key");
    const value = options.getNumber("value");

    if (!SCORE_CONFIG.hasOwnProperty(key)) {
      return interaction.reply({
        content: `❌ Invalid key. Valid: ${Object.keys(SCORE_CONFIG).join(", ")}`,
        ephemeral: true,
      });
    }

    SCORE_CONFIG[key] = value;
    await logAdminAction(user.id, "N/A", `editscores_${key}`, value);

    return interaction.reply({
      content: `✅ Updated \`${key}\` => \`${value}\`.`,
      ephemeral: true,
    });
  }

  // ---- /setreactionchannel (admin/mod) ----
  else if (commandName === "setreactionchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Admin/Mod only.",
        ephemeral: true,
      });
    }
    const channel = options.getChannel("channel");
    if (!channel) {
      return interaction.reply({
        content: "❌ Invalid channel.",
        ephemeral: true,
      });
    }
    const success = await addReactionChannel(channel.id);
    if (!success) {
      return interaction.reply({
        content: "❌ Could not add channel.",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `✅ <#${channel.id}> now awards reaction points.`,
      ephemeral: true,
    });
  }

  // ---- /removereactionchannel (admin/mod) ----
  else if (commandName === "removereactionchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Admin/Mod only.",
        ephemeral: true,
      });
    }
    const channel = options.getChannel("channel");
    if (!channel) {
      return interaction.reply({
        content: "❌ Invalid channel.",
        ephemeral: true,
      });
    }
    const success = await removeReactionChannel(channel.id);
    if (!success) {
      return interaction.reply({
        content: "❌ Could not remove channel.",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `✅ Removed <#${channel.id}> from reaction channels.`,
      ephemeral: true,
    });
  }

  // ---- /setbotlogchannel (admin/mod) ----
  else if (commandName === "setbotlogchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Admin/Mod only.",
        ephemeral: true,
      });
    }
    const channel = options.getChannel("channel");
    if (!channel) {
      return interaction.reply({
        content: "❌ Invalid channel.",
        ephemeral: true,
      });
    }
    BOT_LOG_CHANNEL = channel.id;
    return interaction.reply({
      content: `✅ Bot log channel => <#${channel.id}>.`,
      ephemeral: true,
    });
  }

  // ---- /tweeterupdates (admin/mod) ----
  else if (commandName === "tweeterupdates") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Admin/Mod only.",
        ephemeral: true,
      });
    }
    const channel = options.getChannel("channel");
    if (!channel) {
      return interaction.reply({
        content: "❌ Invalid channel.",
        ephemeral: true,
      });
    }
    TWEET_UPDATES_CHANNEL = channel.id;
    return interaction.reply({
      content: `✅ Tweet updates channel => <#${channel.id}>.`,
      ephemeral: true,
    });
  }

  // ---- /notifytoggle (user) ----
  else if (commandName === "notifytoggle") {
    // Toggle whether they receive "You earned X points" messages
    const { data, error: fetchErr } = await supabase
      .from("users")
      .select("notify_enabled")
      .eq("discord_id", user.id)
      .single();

    if (fetchErr || !data) {
      return interaction.reply({
        content: "❌ Could not find user. Try /verify first.",
        ephemeral: true,
      });
    }

    const newVal = !data.notify_enabled;
    const { error: updateErr } = await supabase
      .from("users")
      .update({ notify_enabled: newVal })
      .eq("discord_id", user.id);

    if (updateErr) {
      return interaction.reply({
        content: "❌ Could not update preference.",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: newVal
        ? "✅ Notifications **enabled**."
        : "✅ Notifications **disabled**.",
      ephemeral: true,
    });
  }

  // ---- /adminhelp (admin) ----
  else if (commandName === "adminhelp") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Admin only.",
        ephemeral: true,
      });
    }
    const desc = `
**/resetpoints** \`<discord_id>\`
• Resets a user's points to 0.

**/editscores** \`<key> <value>\`
• Adjust scoring config (messages, reactions, etc.)

**/setbotlogchannel** \`<channel>\`
• Where bot logs are posted.

**/tweeterupdates** \`<channel>\`
• Where new tweets get announced.

**/setreactionchannel** \`<channel>\`
• Adds a channel awarding reaction points.

**/removereactionchannel** \`<channel>\`
• Removes channel from awarding reaction points.

**/connectwallet** \`<wallet_address>\` (user command, though admin can see usage)
• Once user links SOL wallet, they get 10 points.

**/adminhelp**
• This help menu.

(Admin permission required)`;

    const embed = new EmbedBuilder()
      .setTitle("Admin Commands Help")
      .setColor("Blue")
      .setDescription(desc);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  //Fetch Twitter
  else if (commandName === "fetchtwitter") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Only admins can use this command.",
        ephemeral: true,
      });
    }

    // Immediately tell Discord we're working (avoids 'Unknown interaction')
    await interaction.deferReply({ ephemeral: true });

    try {
      // Potentially time-consuming
      await checkTwitterActivity();

      // Now we can safely edit the original deferred reply
      await interaction.editReply({
        content:
          "✅ Fetched recent tweets from X (Twitter). Check the bot logs!",
      });
    } catch (err) {
      console.error("[fetchtwitter] Error:", err);
      await interaction.editReply({
        content: `❌ Error fetching Twitter data: ${err.message}`,
      });
    }
  }

  // ---- /connectwallet (User) ----
  else if (commandName === "connectwallet") {
    // Let's assume user can only do it once for points
    const walletAddr = options.getString("wallet_address");
    if (!walletAddr) {
      return interaction.reply({
        content: "❌ Invalid wallet address.",
        ephemeral: true,
      });
    }
    // Check if user already has a sol_wallet
    const { data: userRec, error: fetchErr } = await supabase
      .from("users")
      .select("sol_wallet, points, twitter_id, notify_enabled")
      .eq("discord_id", user.id)
      .single();

    if (fetchErr || !userRec) {
      // If no record, upsert with new wallet
      // but we also need them verified for awarding points
      await supabase
        .from("users")
        .upsert([{ discord_id: user.id, sol_wallet: walletAddr }]);
      // awarding the 10 points only if they have a twitter_id
      // let's fetch again:
      const { data: newUserRec } = await supabase
        .from("users")
        .select("twitter_id, notify_enabled, points")
        .eq("discord_id", user.id)
        .single();
      if (!newUserRec.twitter_id) {
        return interaction.reply({
          content:
            "Wallet connected, but you must /verify (link X) to earn points.",
          ephemeral: true,
        });
      }
      // Award points
      const result = await awardPoints(
        user.id,
        SCORE_CONFIG.connectWalletPoints,
        "connect_wallet",
      );
      if (result.newPoints === null) {
        return interaction.reply({
          content: "Wallet connected, but no points. (Check if verified?)",
          ephemeral: true,
        });
      }
      if (result.notifyEnabled) {
        botLog(
          `[connectwallet] ${user.tag} got ${SCORE_CONFIG.connectWalletPoints} points (now ${result.newPoints}).`,
        );
      }
      return interaction.reply({
        content: `✅ Wallet connected! +${SCORE_CONFIG.connectWalletPoints} points awarded.`,
        ephemeral: true,
      });
    } else {
      // We have a record
      if (userRec.sol_wallet) {
        return interaction.reply({
          content:
            "❌ You already have a wallet connected. No additional points.",
          ephemeral: true,
        });
      } else {
        // update with new wallet
        await supabase
          .from("users")
          .update({ sol_wallet: walletAddr })
          .eq("discord_id", user.id);
        if (!userRec.twitter_id) {
          return interaction.reply({
            content: "Wallet connected, but you must /verify to earn points.",
            ephemeral: true,
          });
        }
        // Award points
        const result = await awardPoints(
          user.id,
          SCORE_CONFIG.connectWalletPoints,
          "connect_wallet",
        );
        if (result.newPoints === null) {
          return interaction.reply({
            content: "Wallet connected, but no points. (Check if verified?)",
            ephemeral: true,
          });
        }
        if (result.notifyEnabled) {
          botLog(
            `[connectwallet] ${user.tag} got ${SCORE_CONFIG.connectWalletPoints} points (now ${result.newPoints}).`,
          );
        }
        return interaction.reply({
          content: `✅ Wallet connected! +${SCORE_CONFIG.connectWalletPoints} points.`,
          ephemeral: true,
        });
      }
    }
  }
});

/********************************************************************
 *                      MESSAGE HANDLER
 ********************************************************************/
/**
 * We do 1 point per 5 messages, up to 20 points per day.
 */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const today = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"

  if (!dailyMessageTracker[userId]) {
    dailyMessageTracker[userId] = {
      date: today,
      messagesSoFar: 0,
      pointsEarnedToday: 0,
    };
  } else {
    // If date changed, reset
    if (dailyMessageTracker[userId].date !== today) {
      dailyMessageTracker[userId] = {
        date: today,
        messagesSoFar: 0,
        pointsEarnedToday: 0,
      };
    }
  }

  dailyMessageTracker[userId].messagesSoFar += 1;

  // Check if they've already hit 20 points for the day
  if (
    dailyMessageTracker[userId].pointsEarnedToday >=
    SCORE_CONFIG.messageMaxPointsPerDay
  ) {
    // They can't earn more from messages
    return;
  }

  // If they've reached multiples of 5 messages
  if (
    dailyMessageTracker[userId].messagesSoFar %
      SCORE_CONFIG.messagesPerPoint ===
    0
  ) {
    // Award 1 point
    const potentialPoints = 1;
    // But don't exceed daily max
    const canStillEarn =
      SCORE_CONFIG.messageMaxPointsPerDay -
      dailyMessageTracker[userId].pointsEarnedToday;
    const pointsToAward = Math.min(potentialPoints, canStillEarn);

    if (pointsToAward <= 0) return;

    // Now we do the awarding
    const result = await awardPoints(userId, pointsToAward, "message_points");
    dailyMessageTracker[userId].pointsEarnedToday += pointsToAward;

    if (
      result &&
      result.newPoints !== null &&
      result.notifyEnabled &&
      result.verified
    ) {
      botLog(
        `[messageCreate] ${message.author.tag} +${pointsToAward} (total: ${result.newPoints}).`,
      );
      message.reply(
        `🎉 You earned **${pointsToAward} point**! You've now earned **${dailyMessageTracker[userId].pointsEarnedToday}** message pts today.`,
      );
    }
  }
});

/********************************************************************
 *                     REACTION HANDLER
 ********************************************************************/
/**
 * If reaction is in a "reaction channel" (like an announcements channel),
 * award 2 points.
 */
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  // Only award points if channel is in REACTION_CHANNELS
  if (!REACTION_CHANNELS.includes(reaction.message.channelId)) {
    return;
  }

  const result = await awardPoints(
    user.id,
    SCORE_CONFIG.reactionPoints,
    "reaction_points",
  );
  if (
    result &&
    result.newPoints !== null &&
    result.notifyEnabled &&
    result.verified
  ) {
    botLog(
      `[messageReactionAdd] ${user.tag} +${SCORE_CONFIG.reactionPoints} (total: ${result.newPoints}).`,
    );
    // Typically we don't reply for a reaction, but you could do so if you want
    // reaction.message.reply(...)
  }
});

/********************************************************************
 *                      TWITTER POLLING
 ********************************************************************/
async function checkTwitterActivity() {
  botLog("[checkTwitterActivity] Polling Twitter for new tweets...");

  // 1. Get official account user ID
  let account;
  try {
    account = await twitterClient.v2.userByUsername(OFFICIAL_TWITTER_ACCOUNT);
  } catch (err) {
    botLog(
      `[checkTwitterActivity] Could not fetch user @${OFFICIAL_TWITTER_ACCOUNT}. Error: ${err}`,
    );
    return;
  }
  if (!account?.data?.id) {
    botLog(
      `[checkTwitterActivity] No valid user ID for ${OFFICIAL_TWITTER_ACCOUNT}.`,
    );
    return;
  }

  // 2. Fetch timeline (recent 5 tweets)
  let timeline;
  try {
    timeline = await twitterClient.v2.userTimeline(account.data.id, {
      max_results: 5,
      expansions: ["author_id"],
      "tweet.fields": ["created_at"],
    });
  } catch (err) {
    botLog(`[checkTwitterActivity] Error fetching timeline: ${err}`);
    return;
  }
  if (!timeline?.data?.data) {
    botLog("[checkTwitterActivity] No tweets found in timeline.");
    return;
  }

  const tweets = timeline.data.data;

  // 3. For each tweet, see if we've processed it, if not => post & check engagement
  for (const tw of tweets) {
    const processed = await hasProcessedTweet(tw.id);
    if (!processed) {
      await markTweetAsProcessed(tw.id);

      if (TWEET_UPDATES_CHANNEL) {
        try {
          const updatesChan = await client.channels.fetch(
            TWEET_UPDATES_CHANNEL,
          );
          if (updatesChan) {
            updatesChan.send(
              `**New Tweet from @${OFFICIAL_TWITTER_ACCOUNT}**\nhttps://twitter.com/${OFFICIAL_TWITTER_ACCOUNT}/status/${tw.id}`,
            );
          }
        } catch (err) {
          botLog(`[checkTwitterActivity] Error posting new tweet: ${err}`);
        }
      }
    }

    // Attempt awarding points for likes, retweets, etc.
    await awardTweetEngagementPoints(tw.id);
  }
}

// Helper: hasProcessedTweet & markTweetAsProcessed
async function hasProcessedTweet(tweetId) {
  const { data, error } = await supabase
    .from("processed_tweets")
    .select("tweet_id")
    .eq("tweet_id", tweetId)
    .single();
  if (error && error.details?.includes("0 rows")) {
    return false;
  }
  return !!data;
}

async function markTweetAsProcessed(tweetId) {
  const { error } = await supabase
    .from("processed_tweets")
    .insert([{ tweet_id: tweetId }]);
  if (error) {
    botLog(`[markTweetAsProcessed] Error: ${error.message}`);
  }
}

/**
 * Checks likes/retweets for the tweet, and tries to see if we can differentiate
 * standard retweets vs. quote retweets, replies, etc.
 * Note: The free Twitter API doesn't easily provide quote-retweet or reply data,
 * so this is mostly placeholder logic.
 */
async function awardTweetEngagementPoints(tweetId) {
  // 1. Get all verified users
  const { data: users, error } = await supabase
    .from("users")
    .select("discord_id, twitter_id, notify_enabled");
  if (error || !users) {
    botLog(`[awardTweetEngagementPoints] Error/no users: ${error?.message}`);
    return;
  }

  // 2. Attempt fetching likes & retweets
  let tweetLikes, tweetRetweets;
  try {
    tweetLikes = await twitterClient.v2.tweetLikedBy(tweetId);
    tweetRetweets = await twitterClient.v2.tweetRetweetedBy(tweetId);

    // If you had an endpoint for replies or quote tweets, you'd call them here
    // e.g. tweetReplies = await ...
  } catch (err) {
    if (String(err).includes("403")) {
      botLog(
        `[awardTweetEngagementPoints] 403 for tweet ${tweetId}; skipping...`,
      );
    } else {
      botLog(`[awardTweetEngagementPoints] Error for tweet ${tweetId}: ${err}`);
    }
    return;
  }

  const likesData = tweetLikes?.data?.data || [];
  const retweetsData = tweetRetweets?.data?.data || [];

  // If you had a way to detect "quote retweet" or "reply," you’d do it here,
  // but the standard free endpoints won't show that.
  // We'll assume standard retweets => +7, we can't see if they quoted it.
  // We'll skip awarding "reply" or "quoteRetweet" in reality.
  // This is just a placeholder if you had the necessary expansions.

  // 3. For each user, see if they appear in likes or retweets
  for (const u of users) {
    if (!u.twitter_id) continue;

    // Liked?
    if (likesData.some((like) => like.id === u.twitter_id)) {
      const result = await awardPoints(
        u.discord_id,
        SCORE_CONFIG.likePoints,
        "twitter_like",
      );
      if (
        result.newPoints !== null &&
        result.notifyEnabled &&
        result.verified
      ) {
        botLog(
          `[Twitter] <@${u.discord_id}> liked => +${SCORE_CONFIG.likePoints} (total: ${result.newPoints}).`,
        );
      }
    }

    // Retweeted? (We can't see if it was quote retweet or standard retweet, so awarding retweetPoints)
    if (retweetsData.some((rt) => rt.id === u.twitter_id)) {
      const result = await awardPoints(
        u.discord_id,
        SCORE_CONFIG.retweetPoints,
        "twitter_retweet",
      );
      if (
        result.newPoints !== null &&
        result.notifyEnabled &&
        result.verified
      ) {
        botLog(
          `[Twitter] <@${u.discord_id}> retweeted => +${SCORE_CONFIG.retweetPoints} (total: ${result.newPoints}).`,
        );
      }
    }

    // If you had an API method to detect "reply" or "quote retweet", do similar logic:
    // if (somehowDetectedReply(u.twitter_id, tweetId)) {
    //   awardPoints(u.discord_id, SCORE_CONFIG.replyPoints, "twitter_reply");
    // }
    // if (somehowDetectedQuoteRetweet) { ... etc }
  }
}

/********************************************************************
 *                          BOT LOGIN
 ********************************************************************/
client.login(process.env.DISCORD_TOKEN).then(async () => {
  console.log("[Bot] Bot logged in successfully.");

  // Load reaction channels from DB
  await loadReactionChannels();

  // Poll Twitter every 15 minutes
  setInterval(checkTwitterActivity, 15 * 60 * 1000);
});
