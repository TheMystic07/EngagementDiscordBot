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
// For message-based points, track daily usage:
const dailyMessageTracker = {};
// e.g. dailyMessageTracker[discordId] = {
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
 * Scoring config:
 *  - 1 point per 5 messages (max 20 points/day)
 *  - Reactions: 2 points
 *  - Connect Wallet: 10 points
 *  - Like: 4 points
 *  - Retweet: 7 points
 *  - Quote Retweet: 10 points
 *  - Reply: 8 points
 */
const SCORE_CONFIG = {
  messagesPerPoint: 5,
  messageMaxPointsPerDay: 20,
  messageReward: 1, // how many points each time threshold is reached
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
 * Log to console + optionally a Discord bot-log channel.
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
 *      LOAD REACTION CHANNELS (FROM DB)
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
 *                UPDATE GOLD_POINTS & LOG ACTIVITY
 ********************************************************************/
/**
 * Award points in the `gold_points` column if user is "verified" (has twitter_id).
 * Logs the action in the activity_logs table if pointsToAdd != 0.
 */
async function awardPoints(discordId, pointsToAdd, action) {
  // 1. Fetch user row
  const { data: userData, error } = await supabase
    .from("users")
    .select("gold_points, twitter_id, notify_enabled")
    .eq("discord_id", discordId)
    .single();

  if (error || !userData) {
    return { newPoints: null, notifyEnabled: true, verified: false };
  }
  if (!userData.twitter_id) {
    // means user not "verified"
    return { newPoints: null, notifyEnabled: true, verified: false };
  }

  // 2. Update gold_points
  const oldPoints = userData.gold_points || 0;
  const newPoints = oldPoints + pointsToAdd;

  const { error: updateErr } = await supabase
    .from("users")
    .update({ gold_points: newPoints })
    .eq("discord_id", discordId);

  if (updateErr) {
    botLog(
      `[awardPoints] Error updating user ${discordId}: ${updateErr.message}`,
    );
    return { newPoints: null, notifyEnabled: true, verified: true };
  }

  // 3. Log in activity_logs
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
    // Upsert row with discord_id + twitter_id
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

  // ---- /mypoints => show current gold_points
  else if (commandName === "mypoints") {
    const { data, error } = await supabase
      .from("users")
      .select("gold_points")
      .eq("discord_id", user.id)
      .single();

    if (error) {
      return interaction.reply({
        content: "❌ Error fetching your gold points.",
        ephemeral: true,
      });
    }
    if (!data) {
      return interaction.reply({
        content: "😕 You have no record yet. /verify to start earning points!",
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: `You have **${data.gold_points}** gold points!`,
      ephemeral: true,
    });
  }

  // ---- /addpoints => admin can add gold_points to user or role
  else if (commandName === "addpoints") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Only admins can use this command.",
        ephemeral: true,
      });
    }

    const pointsToAdd = options.getInteger("points");
    const targetUser = options.getUser("user");
    const targetRole = options.getRole("role");

    // Must specify either user or role
    if (!targetUser && !targetRole) {
      return interaction.reply({
        content: "❌ You must specify either a user or a role.",
        ephemeral: true,
      });
    }
    if (pointsToAdd <= 0) {
      return interaction.reply({
        content: "❌ Points must be > 0.",
        ephemeral: true,
      });
    }

    // Single user
    if (targetUser && !targetRole) {
      const userId = targetUser.id;
      const result = await awardPoints(userId, pointsToAdd, "manual_addpoints");
      if (result && result.newPoints !== null) {
        await logAdminAction(user.id, userId, "addpoints_user", pointsToAdd);
        return interaction.reply({
          content: `✅ Added **${pointsToAdd}** gold points to <@${userId}>.`,
          ephemeral: true,
        });
      } else {
        return interaction.reply({
          content: `❌ Could not add points to <@${userId}> (not verified or error).`,
          ephemeral: true,
        });
      }
    }

    // Role
    else if (targetRole) {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.reply({
          content: "❌ Could not fetch guild.",
          ephemeral: true,
        });
      }

      let roleMembers;
      try {
        // fetch all members to ensure we have them in cache
        await guild.members.fetch();
        roleMembers = targetRole.members;
      } catch (err) {
        console.error("[addpoints] Error fetching role members:", err);
        return interaction.reply({
          content: `❌ Could not fetch members for role <@&${targetRole.id}>.`,
          ephemeral: true,
        });
      }

      if (!roleMembers || roleMembers.size === 0) {
        return interaction.reply({
          content: `No members found with role <@&${targetRole.id}>.`,
          ephemeral: true,
        });
      }

      let successCount = 0;
      let failCount = 0;

      for (const [memberId, guildMember] of roleMembers) {
        if (guildMember.user.bot) continue; // skip bots
        const result = await awardPoints(
          memberId,
          pointsToAdd,
          "manual_addpoints_role",
        );
        if (result && result.newPoints !== null) {
          successCount++;
          await logAdminAction(
            user.id,
            memberId,
            "addpoints_role",
            pointsToAdd,
          );
        } else {
          failCount++;
        }
      }

      return interaction.reply({
        content: `✅ **${successCount}** members updated, **${failCount}** failed/not verified, in role <@&${targetRole.id}>.`,
        ephemeral: true,
      });
    }
  }

  // ---- /leaderboard => top 10 gold_points
  else if (commandName === "leaderboard") {
    const { data, error } = await supabase
      .from("users")
      .select("discord_id, gold_points")
      .order("gold_points", { ascending: false })
      .limit(10);

    if (error) {
      return interaction.reply("❌ Error fetching leaderboard.");
    }

    const leaderboard = data
      .map(
        (u, i) =>
          `${i + 1}. <@${u.discord_id}> - **${u.gold_points}** gold points`,
      )
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor("#FFD700")
      .setTitle("🏆 Leaderboard")
      .setDescription(leaderboard || "No data.");

    return interaction.reply({ embeds: [embed] });
  }

  // ---- /resetpoints => set gold_points = 0
  else if (commandName === "resetpoints") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Admin only.",
        ephemeral: true,
      });
    }

    const targetId = options.getString("discord_id");
    const { data: oldData, error: oldErr } = await supabase
      .from("users")
      .select("gold_points")
      .eq("discord_id", targetId)
      .single();

    if (oldErr || !oldData) {
      return interaction.reply({
        content: "❌ That user doesn't exist or wasn't found.",
        ephemeral: true,
      });
    }

    const oldPoints = oldData.gold_points;

    const { error: updErr } = await supabase
      .from("users")
      .update({ gold_points: 0 })
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
      content: `✅ Reset gold points for <@${targetId}>.`,
      ephemeral: true,
    });
  }

  // ---- /scorehelp => same as before
  else if (commandName === "scorehelp") {
    const helpMsg = `
**Scoring Rules:**
• **Messages**: 1 point per 5 messages, up to 20 pts/day
• **Reactions (Announcements)**: ${SCORE_CONFIG.reactionPoints} points
• **Connect Wallet**: ${SCORE_CONFIG.connectWalletPoints} points
• **Like**: ${SCORE_CONFIG.likePoints} points
• **Retweet**: ${SCORE_CONFIG.retweetPoints} points
• **Quote Retweet**: ${SCORE_CONFIG.quoteRetweetPoints} points
• **Reply**: ${SCORE_CONFIG.replyPoints} points
`;
    return interaction.reply({ content: helpMsg, ephemeral: true });
  }

  // ---- /editscores => update the in-memory config
  else if (commandName === "editscores") {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: "🚫 Only admins or mods can use this command.",
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

  // ---- /setreactionchannel => store in DB
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

  // ---- /removereactionchannel => remove from DB
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

  // ---- /setbotlogchannel => for logging
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

  // ---- /tweeterupdates => channel for new tweets
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

  // ---- /notifytoggle => user toggles notify_enabled
  else if (commandName === "notifytoggle") {
    const { data, error: fetchErr } = await supabase
      .from("users")
      .select("notify_enabled")
      .eq("discord_id", user.id)
      .single();

    if (fetchErr || !data) {
      return interaction.reply({
        content: "❌ Could not find your user record. Try /verify first.",
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

  // ---- /adminhelp => same as before
  else if (commandName === "adminhelp") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: "🚫 Admin only.", ephemeral: true });
    }
    const desc = `
**/resetpoints** \`<discord_id>\`
• Sets user's gold_points to 0

**/editscores** \`<key> <value>\`
• Change the scoring config

**/setbotlogchannel** \`<channel>\`
• Where bot logs go

**/tweeterupdates** \`<channel>\`
• Where new tweets get announced

**/setreactionchannel** \`<channel>\`
• Channel awarding reaction points

**/removereactionchannel** \`<channel>\`
• Remove a channel from awarding reaction points

**/connectwallet** \`<wallet_address>\`
• Once user links wallet, they get 10 points

**/adminhelp**
• This help menu
    `;

    const embed = new EmbedBuilder()
      .setTitle("Admin Commands Help")
      .setColor("Blue")
      .setDescription(desc);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ---- /fetchtwitter => admin-only immediate poll of Twitter
  else if (commandName === "fetchtwitter") {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: "🚫 Only admins can use this command.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      await checkTwitterActivity(); // The function that polls & awards points
      await interaction.editReply({
        content: "✅ Fetched recent tweets. Check bot logs!",
      });
    } catch (err) {
      console.error("[fetchtwitter] Error:", err);
      await interaction.editReply({
        content: `❌ Error fetching data: ${err.message}`,
      });
    }
  }

  // ---- /connectwallet => user can link a wallet for 10 points
  else if (commandName === "connectwallet") {
    const walletAddr = options.getString("wallet_address");
    if (!walletAddr) {
      return interaction.reply({
        content: "❌ Invalid wallet address.",
        ephemeral: true,
      });
    }

    // Check if user row exists
    const { data: userRec, error: fetchErr } = await supabase
      .from("users")
      .select("sol_wallet, gold_points, twitter_id, notify_enabled")
      .eq("discord_id", user.id)
      .single();

    if (fetchErr || !userRec) {
      // If no record, upsert
      await supabase
        .from("users")
        .upsert([{ discord_id: user.id, sol_wallet: walletAddr }]);
      // Re-check to see if they have twitter_id
      const { data: newUserRec } = await supabase
        .from("users")
        .select("twitter_id, notify_enabled, gold_points")
        .eq("discord_id", user.id)
        .single();

      if (!newUserRec || !newUserRec.twitter_id) {
        return interaction.reply({
          content:
            "Wallet connected. Please /verify (link Twitter) to earn points.",
          ephemeral: true,
        });
      }
      // Award connectWalletPoints
      const result = await awardPoints(
        user.id,
        SCORE_CONFIG.connectWalletPoints,
        "connect_wallet",
      );
      if (result.newPoints === null) {
        return interaction.reply({
          content: "Wallet connected, but no points. Possibly not verified?",
          ephemeral: true,
        });
      }
      if (result.notifyEnabled) {
        botLog(
          `[connectwallet] ${user.tag} +${SCORE_CONFIG.connectWalletPoints} (now ${result.newPoints}).`,
        );
      }
      return interaction.reply({
        content: `✅ Wallet connected! +${SCORE_CONFIG.connectWalletPoints} gold points.`,
        ephemeral: true,
      });
    } else {
      // We have an existing record
      if (userRec.sol_wallet) {
        return interaction.reply({
          content: "❌ You already have a wallet connected.",
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
        const result = await awardPoints(
          user.id,
          SCORE_CONFIG.connectWalletPoints,
          "connect_wallet",
        );
        if (result.newPoints === null) {
          return interaction.reply({
            content:
              "Wallet connected, but no points awarded. Possibly not verified?",
            ephemeral: true,
          });
        }
        if (result.notifyEnabled) {
          botLog(
            `[connectwallet] ${user.tag} +${SCORE_CONFIG.connectWalletPoints} (total: ${result.newPoints}).`,
          );
        }
        return interaction.reply({
          content: `✅ Wallet connected! +${SCORE_CONFIG.connectWalletPoints} gold points.`,
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
 * 1 point per 5 messages, up to 20 points / day
 */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const today = new Date().toISOString().split("T")[0];

  if (!dailyMessageTracker[userId]) {
    dailyMessageTracker[userId] = {
      date: today,
      messagesSoFar: 0,
      pointsEarnedToday: 0,
    };
  } else {
    if (dailyMessageTracker[userId].date !== today) {
      dailyMessageTracker[userId] = {
        date: today,
        messagesSoFar: 0,
        pointsEarnedToday: 0,
      };
    }
  }

  dailyMessageTracker[userId].messagesSoFar += 1;

  // If they've already reached 20 points from messages, stop
  if (
    dailyMessageTracker[userId].pointsEarnedToday >=
    SCORE_CONFIG.messageMaxPointsPerDay
  ) {
    return;
  }

  // If they hit multiples of 5
  // If they've reached multiples of SCORE_CONFIG.messagesPerPoint
  if (
    dailyMessageTracker[userId].messagesSoFar %
      SCORE_CONFIG.messagesPerPoint ===
    0
  ) {
    // Use the config's "messageReward" points each time
    const potentialPoints = SCORE_CONFIG.messageReward;

    // But don't exceed daily max
    const canStillEarn =
      SCORE_CONFIG.messageMaxPointsPerDay -
      dailyMessageTracker[userId].pointsEarnedToday;

    const pointsToAward = Math.min(potentialPoints, canStillEarn);

    if (pointsToAward <= 0) return;

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
        `🎉 You earned **${pointsToAward}** point(s)! You've now earned **${dailyMessageTracker[userId].pointsEarnedToday}** message pts today.`,
      );
    }
  }
});

/********************************************************************
 *                     REACTION HANDLER
 ********************************************************************/
/**
 * If user reacts in an allowed channel => +2 gold points
 */
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (!REACTION_CHANNELS.includes(reaction.message.channelId)) return;

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
    // we typically don't reply to a reaction, but you could
  }
});

/********************************************************************
 *                      TWITTER POLLING
 ********************************************************************/
async function checkTwitterActivity() {
  botLog("[checkTwitterActivity] Polling Twitter for new tweets...");

  // 1. get official user ID
  let account;
  try {
    account = await twitterClient.v2.userByUsername(OFFICIAL_TWITTER_ACCOUNT);
  } catch (err) {
    botLog(
      `[checkTwitterActivity] Could not fetch @${OFFICIAL_TWITTER_ACCOUNT}: ${err}`,
    );
    return;
  }
  if (!account?.data?.id) {
    botLog(
      `[checkTwitterActivity] No valid user ID for @${OFFICIAL_TWITTER_ACCOUNT}.`,
    );
    return;
  }

  // 2. fetch timeline
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

    // Attempt awarding points for likes/retweets
    await awardTweetEngagementPoints(tw.id);
  }
}

// Check if tweet is processed
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
 * Check likes/retweets for a tweet, awarding gold_points
 * if the user is verified in DB.
 */
async function awardTweetEngagementPoints(tweetId) {
  const { data: users, error } = await supabase
    .from("users")
    .select("discord_id, twitter_id, notify_enabled");
  if (error || !users) {
    botLog(`[awardTweetEngagementPoints] Error/no users: ${error?.message}`);
    return;
  }

  let tweetLikes, tweetRetweets;
  try {
    tweetLikes = await twitterClient.v2.tweetLikedBy(tweetId);
    tweetRetweets = await twitterClient.v2.tweetRetweetedBy(tweetId);
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

    // Retweeted?
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
    // If you had a way to detect "reply" or "quote retweet," you'd do so here
  }
}

/********************************************************************
 *                          BOT LOGIN
 ********************************************************************/
client.login(process.env.DISCORD_TOKEN).then(async () => {
  console.log("[Bot] Bot logged in successfully.");

  // Load reaction channels
  await loadReactionChannels();

  // Poll Twitter every 15 minutes
  setInterval(checkTwitterActivity, 15 * 60 * 1000);
});
