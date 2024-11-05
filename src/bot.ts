import { Client, GatewayIntentBits, Partials, Events, Guild, EmbedBuilder, TextChannel } from 'discord.js';
import { config } from 'dotenv';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

config();

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

const ADMIN_USER_ID = '721017166652244018';
const TARGET_ROLE_ID = '1289017750722969653';
const CHECK_INTERVAL = 1000 * 60 * 60 * 24;
const MAX_EMBED_DESCRIPTION_LENGTH = 1024;

let db: Database<sqlite3.Database, sqlite3.Statement>;

(async () => {
  db = await open({
    filename: './userActivity.db',
    driver: sqlite3.Database
  });

  await db.run(`
    CREATE TABLE IF NOT EXISTS user_activity (
      user_id TEXT PRIMARY KEY,
      last_message_timestamp INTEGER
    )
  `);
})();

bot.on(Events.MessageCreate, async (message) => {
  if (!message.author.bot) {
    const userId = message.author.id;
    const timestamp = Date.now();

    await db.run(
      `
      INSERT INTO user_activity (user_id, last_message_timestamp)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_message_timestamp=excluded.last_message_timestamp
    `,
      userId, timestamp
    );

    console.log(`Updated activity for user: ${message.author.tag} (${userId})`);
  }

  if (message.content === '!checkInactive') {
    if (!message.guild) {
      return message.reply("This command can only be used in a server.");
    }

    getInactiveUsers(message.guild).then((inactiveUsers) => {
      const embeds = createInactiveUserEmbeds(inactiveUsers);
      embeds.forEach(embedBatch => {
        message.channel.send({ embeds: embedBatch });
      });
    }).catch(error => {
      console.error('Error fetching inactive users:', error);
      message.channel.send('There was an error retrieving inactive users.');
    });
  }

  if (message.content === '!showUsers') {
    if (message.channel instanceof TextChannel) {
      await showUsersInDb(message.channel);
    } else {
      message.reply("This command can only be used in a text channel.");
    }
  }
});

async function getInactiveUsers(guild: Guild) {
    const now = Date.now();
    const twoWeeksInMillis = 1000 * 60 * 60 * 24 * 14;
    const inactiveUsers = [];

    try {
        const members = await guild.members.fetch();
        console.log(`Fetched ${members.size} members from the guild.`);

        for (const member of members.values()) {
            const result = await db.get<{ last_message_timestamp: number }>(
                'SELECT last_message_timestamp FROM user_activity WHERE user_id = ?',
                member.id
            );
            const lastMessageTimestamp = result?.last_message_timestamp || 0;
            const inactivityDuration = now - lastMessageTimestamp;

            console.log(`Checking user: ${member.user.tag} (${member.id}), Last activity: ${lastMessageTimestamp ? new Date(lastMessageTimestamp).toLocaleString() : 'Never'}, Inactivity duration: ${inactivityDuration}ms`);

            if (
                inactivityDuration > twoWeeksInMillis &&
                lastMessageTimestamp > 0 &&
                member.roles.cache.has(TARGET_ROLE_ID)
            ) {
                inactiveUsers.push({
                    id: member.id,
                    lastActivity: lastMessageTimestamp ? new Date(lastMessageTimestamp).toLocaleString() : "Never",
                });
            }
        }
    } catch (error) {
        console.error('Error fetching members:', error);
    }

    return inactiveUsers;
}

async function showUsersInDb(channel: TextChannel) {
    try {
      const users = await db.all('SELECT user_id, last_message_timestamp FROM user_activity');
      const embeds = createUsersEmbed(users);
      embeds.forEach(embedBatch => {
        channel.send({ embeds: embedBatch });
      });
    } catch (error) {
      console.error('Error fetching users from database:', error);
      channel.send('There was an error retrieving users from the database.');
    }
  }
  
  
  bot.on(Events.MessageCreate, async (message) => {
  
    if (message.content === '!showUsers') {
      if (message.channel instanceof TextChannel) {
        showUsersInDb(message.channel);
      } else {
        message.reply("This command can only be used in a text channel.");
      }
    }
  });

function createUsersEmbed(users: { user_id: string; last_message_timestamp: number }[]): EmbedBuilder[][] {
  if (users.length === 0) {
    return [
      [
        new EmbedBuilder()
          .setTitle('Users in Database')
          .setColor('#FF0000')
          .setDescription('No users found in the database.')
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })
      ],
    ];
  }

  const embeds: EmbedBuilder[][] = [];
  let currentBatch: EmbedBuilder[] = [];
  let currentDescription = '';

  users.forEach((user, index) => {
    const lastActiveDate = user.last_message_timestamp ? new Date(user.last_message_timestamp).toLocaleString() : 'Never';
    const userEntry = `<@${user.user_id}> - Last active: ${lastActiveDate}\n`;

    if (currentDescription.length + userEntry.length > MAX_EMBED_DESCRIPTION_LENGTH) {
      currentBatch.push(
        new EmbedBuilder()
          .setTitle('Users in Database')
          .setColor('#00FF00')
          .setDescription(currentDescription)
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })
      );
      currentDescription = userEntry;

      if (currentBatch.length >= 10) {
        embeds.push(currentBatch);
        currentBatch = [];
      }
    } else {
      currentDescription += userEntry;
    }

    if (index === users.length - 1 && currentDescription.length > 0) {
      currentBatch.push(
        new EmbedBuilder()
          .setTitle('Users in Database')
          .setColor('#00FF00')
          .setDescription(currentDescription)
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })
      );
      embeds.push(currentBatch);
    }
  });

  return embeds;
}

function createInactiveUserEmbeds(inactiveUsers: { id: string; lastActivity: string }[]): EmbedBuilder[][] {
  if (inactiveUsers.length === 0) {
    return [
      [
        new EmbedBuilder()
          .setTitle('Inactive Users')
          .setColor('#FF0000')
          .setDescription('No inactive users found.')
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })

      ],
    ];
  }

  const embeds: EmbedBuilder[][] = [];
  let currentBatch: EmbedBuilder[] = [];
  let currentDescription = '';

  inactiveUsers.forEach((user, index) => {
    const userEntry = `<@${user.id}> - Last active: ${user.lastActivity}\n`;

    if (currentDescription.length + userEntry.length > MAX_EMBED_DESCRIPTION_LENGTH) {
      currentBatch.push(
        new EmbedBuilder()
          .setTitle('Inactive Users')
          .setColor('#FF0000')
          .setDescription(currentDescription)
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })
      );
      currentDescription = userEntry;

      if (currentBatch.length >= 10) {
        embeds.push(currentBatch);
        currentBatch = [];
      }
    } else {
      currentDescription += userEntry;
    }

    if (index === inactiveUsers.length - 1 && currentDescription.length > 0) {
      currentBatch.push(
        new EmbedBuilder()
          .setTitle('Inactive Users')
          .setColor('#FF0000')
          .setDescription(currentDescription)
          .setFooter({ text: 'Please note that this is tracked via the database. Users who have not spoke in **ages** will not be tracked here!' })
      );
      embeds.push(currentBatch);
    }
  });

  return embeds;
}

bot.once(Events.ClientReady, () => {
  console.log(`[Cattata] Initial login: ${bot.user?.tag}`);
  setInterval(async () => {
    const firstGuild = bot.guilds.cache.first();
    if (firstGuild) {
      getInactiveUsers(firstGuild).then(inactiveUsers => {
      }).catch(error => {
        console.error('Error during scheduled inactive user check:', error);
      });
    }
  }, CHECK_INTERVAL);
});

bot.login(process.env.BOT_TOKEN);
