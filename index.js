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
 *         TRACKERS & IN-MEMORY CONFIG (Optionally store in DB)
 ********************************************************************/

// Track message counts for awarding message-based points
const messageCounts = {};

// Reaction channels in memory (loaded from DB)
let REACTION_CHANNELS = [];

// Bot log channel ID (if stored in DB, load from settings)
let BOT_LOG_CHANNEL = null;

// Tweet updates channel ID (if stored in DB, load from settings)
let TWEET_UPDATES_CHANNEL = null;

/**
 * Scoring config (you can also store these in "settings" if you prefer).
 */
let SCORE_CONFIG = {
  messagesPerPoint: 5,
  messagePoints: 10,
  reactionPoints: 5,
  likePoints: 10,
  retweetPoints: 10,
};

/********************************************************************
 *                      LOGGING HELPERS
 ********************************************************************/

/**
 * Logs a message to console AND to the configured bot log channel.
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
 *      LOAD REACTION CHANNELS & SETTINGS (IF STORING IN "settings")
 ********************************************************************/

/**
 * Loads reaction channel IDs from "reaction_channels" table into REACTION_CHANNELS array.
 */
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
 *              UPDATE POINTS (CHECK VERIFICATION / LOGGING)
 ********************************************************************/
/**
 * Updates a user's points if they're verified. If not verified, notifies them.
 * Also logs the activity to "activity_logs".
 *
 * @param {string} discordId  The user's Discord ID.
 * @param {number} pointsToAdd The number of points to add.
 * @param {object} channel (optional) If provided, we can send a "verify first" message.
 * @param {string} action (optional) e.g. "message_points", "reaction_points", "twitter_like"
 *
 * @returns {object|null} Returns { newPoints, notifyEnabled } or null if not updated
 */
async function awardPoints(
  discordId,
  pointsToAdd,
  channel = null,
  action = "points_award",
) {
  const { data: userData, error } = await supabase
    .from("users")
    .select("points, twitter_id, notify_enabled")
    .eq("discord_id", discordId)
    .single();

  if (error || !userData) {
    if (channel) {
      channel.send(
        `<@${discordId}> You have not verified your Twitter account. Use /verify to earn points!`,
      );
    }
    return null;
  }
  if (!userData.twitter_id) {
    if (channel) {
      channel.send(
        `<@${discordId}> You have not verified your Twitter account. Use /verify to earn points!`,
      );
    }
    return null;
  }

  const oldPoints = userData.points || 0;
  const newPoints = oldPoints + pointsToAdd;

  // Update the user row
  const { error: updateErr } = await supabase
    .from("users")
    .update({ points: newPoints, updated_at: new Date() })
    .eq("discord_id", discordId);

  if (updateErr) {
    botLog(
      `[awardPoints] Error updating user ${discordId}: ${updateErr.message}`,
    );
    return null;
  }

  // Log in activity_logs
  if (pointsToAdd !== 0) {
    await logActivity(discordId, action, pointsToAdd);
  }

  return { newPoints, notifyEnabled: userData.notify_enabled };
}

/********************************************************************
 *                       SLASH COMMAND HANDLER
 ********************************************************************/
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName, options, user, member } = interaction;

  // ------------------- /verify -------------------
  if (commandName === "verify") {
    const twitterId = options.getString("twitter_id");
    // Upsert user
    const { error } = await supabase
      .from("users")
      .upsert([{ discord_id: user.id, twitter_id: twitterId }], {
        onConflict: "discord_id",
      });

    if (error) {
      await interaction.reply({
        content:
          "⚠️ Something went wrong linking your Twitter. Please try again.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: `✅ Twitter account \`${twitterId}\` linked successfully!`,
        ephemeral: true,
      });
    }
  }

  // ------------------- /mypoints -------------------
  else if (commandName === "mypoints") {
    const { data, error } = await supabase
      .from("users")
      .select("points")
      .eq("discord_id", user.id)
      .single();

    if (error) {
      await interaction.reply({
        content: "❌ Error fetching your points. Please try again later.",
        ephemeral: true,
      });
    } else if (data) {
      await interaction.reply({
        content: `You currently have **${data.points} points**! Keep it up!`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "😕 You have no points yet. Start interacting to earn points!",
        ephemeral: true,
      });
    }
  }

  // ------------------- /leaderboard (PUBLIC) -------------------
  else if (commandName === "leaderboard") {
    const { data, error } = await supabase
      .from("users")
      .select("discord_id, points")
      .order("points", { ascending: false })
      .limit(10);

    if (error) {
      await interaction.reply({
        content: "❌ Error fetching the leaderboard. Please try again later.",
      });
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
  }

  // ------------------- /resetpoints (ADMIN) -------------------
  else if (commandName === "resetpoints") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Only admins can use this command.",
        ephemeral: true,
      });
    }

    const targetId = options.getString("discord_id");
    // 1. Check old points
    const { data: oldData, error: oldErr } = await supabase
      .from("users")
      .select("points")
      .eq("discord_id", targetId)
      .single();

    if (oldErr || !oldData) {
      return interaction.reply({
        content: "❌ That user does not exist or couldn't be fetched.",
        ephemeral: true,
      });
    }

    const oldPoints = oldData.points;

    // 2. Update points => 0
    const { error } = await supabase
      .from("users")
      .update({ points: 0, updated_at: new Date() })
      .eq("discord_id", targetId);

    if (error) {
      await interaction.reply({
        content: "❌ Error resetting points. Try again.",
        ephemeral: true,
      });
    } else {
      // Log admin action => changed user from oldPoints to 0 => points_changed = -oldPoints
      await logAdminAction(user.id, targetId, "resetpoints", -oldPoints);

      await interaction.reply({
        content: `✅ Points for <@${targetId}> have been reset.`,
        ephemeral: true,
      });
    }
  }

  // ------------------- /scorehelp (ephemeral) -------------------
  else if (commandName === "scorehelp") {
    const help = `
**Points System:**
• **Messages**: Every ${SCORE_CONFIG.messagesPerPoint} messages => +${SCORE_CONFIG.messagePoints} points
• **Reactions** in certain channels => +${SCORE_CONFIG.reactionPoints} points
• **Tweet Likes** => +${SCORE_CONFIG.likePoints} points
• **Tweet Retweets** => +${SCORE_CONFIG.retweetPoints} points
`;
    await interaction.reply({
      content: help,
      ephemeral: true,
    });
  }

  // ------------------- /editscores (ADMIN/MOD) -------------------
  else if (commandName === "editscores") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only administrators or mods can use this command.",
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

    // Optionally log this as an admin action
    await logAdminAction(user.id, "N/A", `editscores_${key}`, value);

    await interaction.reply({
      content: `✅ Updated \`${key}\` to \`${value}\`.`,
      ephemeral: true,
    });
  }

  // ------------------- /setreactionchannel (ADMIN/MOD) -------------------
  else if (commandName === "setreactionchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only administrators or mods can use this command.",
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
    await interaction.reply({
      content: `✅ <#${channel.id}> is now a reaction channel.`,
      ephemeral: true,
    });
  }

  // ------------------- /removereactionchannel (ADMIN/MOD) -------------------
  else if (commandName === "removereactionchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only administrators or mods can use this command.",
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
    await interaction.reply({
      content: `✅ Removed <#${channel.id}> from reaction channels.`,
      ephemeral: true,
    });
  }

  // ------------------- /setbotlogchannel (ADMIN/MOD) -------------------
  else if (commandName === "setbotlogchannel") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only administrators or mods can use this command.",
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
    // If you want to store in DB => upsert into "settings" (key="botLogChannel", value=channel.id)
    await interaction.reply({
      content: `✅ Bot log channel set to <#${channel.id}>.`,
      ephemeral: true,
    });
  }

  // ------------------- /tweeterupdates (ADMIN/MOD) -------------------
  else if (commandName === "tweeterupdates") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only administrators or mods can use this command.",
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
    // If storing in DB => upsert (key="tweetUpdatesChannel", value=channel.id)
    await interaction.reply({
      content: `✅ Tweet updates channel set to <#${channel.id}>.`,
      ephemeral: true,
    });
  }

  // ------------------- /notifytoggle (USER) -------------------
  else if (commandName === "notifytoggle") {
    // Let user toggle whether they receive "You earned X points" messages
    const { data, error: fetchErr } = await supabase
      .from("users")
      .select("notify_enabled")
      .eq("discord_id", user.id)
      .single();

    if (fetchErr || !data) {
      return interaction.reply({
        content: "❌ Could not find your user record. Please /verify first.",
        ephemeral: true,
      });
    }

    const newSetting = !data.notify_enabled;
    const { error: updateErr } = await supabase
      .from("users")
      .update({ notify_enabled: newSetting })
      .eq("discord_id", user.id);

    if (updateErr) {
      return interaction.reply({
        content: "❌ Could not update your notification preference.",
        ephemeral: true,
      });
    }
    await interaction.reply({
      content: newSetting
        ? "✅ Point notifications are now **enabled**."
        : "✅ Point notifications are now **disabled**.",
      ephemeral: true,
    });
  }

  // ------------------- /adminhelp (ADMIN) -------------------
  else if (commandName === "adminhelp") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Only admins can view admin help.",
        ephemeral: true,
      });
    }

    const description = `
**/resetpoints** \`<discord_id>\`
• Resets a user's points to 0.

**/editscores** \`<key> <value>\`
• Changes the scoring config for messages, reactions, etc.

**/setbotlogchannel** \`<channel>\`
• Sets the channel where bot logs will be posted.

**/tweeterupdates** \`<channel>\`
• Sets the channel where new tweets are posted.

**/setreactionchannel** \`<channel>\`
• Adds a channel where reactions grant points.

**/removereactionchannel** \`<channel>\`
• Removes a channel from reaction-points list.

**/adminhelp**
• Displays this help.

Only those with \`ADMINISTRATOR\` permission can use these commands.`;

    const embed = new EmbedBuilder()
      .setTitle("Admin Commands Help")
      .setColor("Blue")
      .setDescription(description);

    // Let's make it ephemeral so only the admin sees it:
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

/********************************************************************
 *                      MESSAGE / REACTION HANDLERS
 ********************************************************************/
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Track user’s message count
  if (!messageCounts[message.author.id]) {
    messageCounts[message.author.id] = 0;
  }
  messageCounts[message.author.id] += 1;

  // If threshold reached, award message points
  if (messageCounts[message.author.id] >= SCORE_CONFIG.messagesPerPoint) {
    const result = await awardPoints(
      message.author.id,
      SCORE_CONFIG.messagePoints,
      message.channel,
      "message_points",
    );
    messageCounts[message.author.id] = 0;

    // Only send "You earned X points!" if user has notifications on
    if (result && result.newPoints !== null && result.notifyEnabled) {
      botLog(
        `[messageCreate] User ${message.author.tag} earned ${SCORE_CONFIG.messagePoints} (total: ${result.newPoints}).`,
      );
      message.reply(
        `🎉 You earned **${SCORE_CONFIG.messagePoints} points**! Your total is now **${result.newPoints} points**.`,
      );
    }
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  // Only award points if channel is in REACTION_CHANNELS
  if (!REACTION_CHANNELS.includes(reaction.message.channelId)) {
    return;
  }

  const result = await awardPoints(
    user.id,
    SCORE_CONFIG.reactionPoints,
    reaction.message.channel,
    "reaction_points",
  );
  if (result && result.newPoints !== null && result.notifyEnabled) {
    botLog(
      `[messageReactionAdd] User ${user.tag} earned ${SCORE_CONFIG.reactionPoints} (total: ${result.newPoints}).`,
    );
    // Typically we don't reply for a reaction, but you could do so if you want:
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
      max_results: 50,
      expansions: ["author_id"],
      "tweet.fields": ["created_at"],
    });
    botLog(
      `[checkTwitterActivity] Fetched ${timeline.data.data.length} tweets.`,
      JSON.stringify(timeline.data.data),
    );
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
    // Check if processed
    const processed = await hasProcessedTweet(tw.id);
    if (!processed) {
      // Mark processed
      await markTweetAsProcessed(tw.id);

      // Post in tweet updates channel
      if (TWEET_UPDATES_CHANNEL) {
        try {
          const updatesChannel = await client.channels.fetch(
            TWEET_UPDATES_CHANNEL,
          );
          if (updatesChannel) {
            updatesChannel.send(
              `**New Tweet from @${OFFICIAL_TWITTER_ACCOUNT}!**\nhttps://twitter.com/${OFFICIAL_TWITTER_ACCOUNT}/status/${tw.id}`,
            );
          }
        } catch (err) {
          botLog(`[checkTwitterActivity] Error posting new tweet: ${err}`);
        }
      }
    }

    // Now attempt awarding points for likes/retweets
    await awardTweetEngagementPoints(tw.id);
  }
}

/**
 * Helper: check if we've processed a tweet
 */
async function hasProcessedTweet(tweetId) {
  const { data, error } = await supabase
    .from("processed_tweets")
    .select("tweet_id")
    .eq("tweet_id", tweetId)
    .single();

  if (error && error.details?.includes("0 rows")) {
    // Not found
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
 * Attempt awarding points for likes/retweets. If 403 => skip awarding.
 */
async function awardTweetEngagementPoints(tweetId) {
  // 1. Get all verified users
  const { data: users, error } = await supabase
    .from("users")
    .select("discord_id, twitter_id, notify_enabled");

  if (error || !users) {
    botLog(
      `[awardTweetEngagementPoints] Error or no users: ${error?.message || ""}`,
    );
    return;
  }

  // 2. Attempt fetching likes & retweets
  let tweetLikes, tweetRetweets;
  try {
    tweetLikes = await twitterClient.v2.tweetLikedBy(tweetId);
    tweetRetweets = await twitterClient.v2.tweetRetweetedBy(tweetId);
  } catch (err) {
    if (String(err).includes("403")) {
      botLog(
        `[awardTweetEngagementPoints] 403 forbidden for tweet ${tweetId}; skipping...`,
      );
    } else {
      botLog(`[awardTweetEngagementPoints] Error for tweet ${tweetId}: ${err}`);
    }
    return;
  }

  const likesData = tweetLikes?.data?.data || [];
  const retweetsData = tweetRetweets?.data?.data || [];

  // 3. For each user, see if they liked or retweeted
  for (const u of users) {
    if (!u.twitter_id) continue;

    // Liked?
    if (likesData.some((like) => like.id === u.twitter_id)) {
      const result = await awardPoints(
        u.discord_id,
        SCORE_CONFIG.likePoints,
        null,
        "twitter_like",
      );
      if (result && result.newPoints !== null && result.notifyEnabled) {
        botLog(
          `[Twitter] <@${u.discord_id}> liked tweet ${tweetId} => +${SCORE_CONFIG.likePoints} (total: ${result.newPoints}).`,
        );
      }
    }

    // Retweeted?
    if (retweetsData.some((rt) => rt.id === u.twitter_id)) {
      const result = await awardPoints(
        u.discord_id,
        SCORE_CONFIG.retweetPoints,
        null,
        "twitter_retweet",
      );
      if (result && result.newPoints !== null && result.notifyEnabled) {
        botLog(
          `[Twitter] <@${u.discord_id}> retweeted ${tweetId} => +${SCORE_CONFIG.retweetPoints} (total: ${result.newPoints}).`,
        );
      }
    }
  }
}

/********************************************************************
 *                          BOT LOGIN
 ********************************************************************/
client.login(process.env.DISCORD_TOKEN).then(async () => {
  console.log("[Bot] Bot logged in successfully.");

  // OPTIONAL: load Reaction Channels from DB
  await loadReactionChannels();

  // Poll Twitter every 10 minutes for new tweets
  setInterval(checkTwitterActivity, 15000);
});
