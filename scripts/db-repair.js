// Bring the database up to the shape the application expects.
//
//   npm run db:repair            show what is missing, change nothing
//   npm run db:repair -- --apply create the missing tables/columns
//
// This project has never had a committed schema: the tables were created by
// hand, so the code and the database drifted apart - which is what made the
// messaging endpoints answer 500 (the `messages` table did not have the
// columns the queries referenced).
//
// It is deliberately ADDITIVE ONLY. It will CREATE a table that does not
// exist and ADD a column that is missing. It never drops, renames, retypes or
// empties anything, so running it cannot lose data. Anything it cannot do
// safely - a rename, a type change - it reports and leaves alone.
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');

const say = (m) => console.log(`  ${m}`);
const ok = (m) => console.log(`  [ OK ]   ${m}`);
const todo = (m) => console.log(`  [TODO]   ${m}`);
const did = (m) => console.log(`  [FIXED]  ${m}`);
const warn = (m) => console.log(`  [warn]   ${m}`);

// The schema the application code actually queries. Column definitions are
// written so they can be used both in CREATE TABLE and in ALTER TABLE ADD.
const SCHEMA = [
  {
    table: 'Users',
    create: `CREATE TABLE Users (
      userId INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      userId: 'INT AUTO_INCREMENT PRIMARY KEY',
      name: 'VARCHAR(100) NOT NULL DEFAULT ""',
      username: 'VARCHAR(50) NOT NULL',
      email: 'VARCHAR(255) NOT NULL',
      password: 'VARCHAR(255) NOT NULL',
    },
  },
  {
    table: 'Categories',
    create: `CREATE TABLE Categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: { id: 'INT AUTO_INCREMENT PRIMARY KEY', name: 'VARCHAR(100) NOT NULL DEFAULT ""' },
  },
  {
    table: 'Files',
    create: `CREATE TABLE Files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      categoryID INT NOT NULL,
      title VARCHAR(150) NOT NULL,
      description VARCHAR(1000) NOT NULL,
      uploadedBy INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      categoryID: 'INT NOT NULL',
      title: 'VARCHAR(150) NOT NULL DEFAULT ""',
      description: 'VARCHAR(1000) NOT NULL DEFAULT ""',
      uploadedBy: 'INT NOT NULL',
    },
  },
  {
    // Comments on a file. models/Chat.js reads and writes this one.
    table: 'chats',
    create: `CREATE TABLE chats (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fileID INT NOT NULL,
      content VARCHAR(1000) NOT NULL,
      userID INT NOT NULL,
      chatDate TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      fileID: 'INT NOT NULL',
      content: 'VARCHAR(1000) NOT NULL DEFAULT ""',
      userID: 'INT NOT NULL',
      chatDate: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    },
  },
  {
    // Direct messages between two users. THIS is the table whose missing
    // columns produced the 500s on /messages/conversations and
    // /messages/thread/:id.
    table: 'messages',
    create: `CREATE TABLE messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      content VARCHAR(1000) NOT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      id: 'INT AUTO_INCREMENT PRIMARY KEY',
      sender_id: 'INT NOT NULL',
      receiver_id: 'INT NOT NULL',
      content: 'VARCHAR(1000) NOT NULL DEFAULT ""',
      sent_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    },
    // Older hand-made versions of this table used these names instead. If one
    // of them is present the data is still readable (models/Message.js adapts
    // to it), so the column is NOT added twice - it is reported instead.
    aliases: {
      id: ['messageId', 'message_id', 'msgId', 'msg_id'],
      sender_id: ['senderId', 'sender', 'from_id', 'fromId'],
      receiver_id: ['receiverId', 'receiver', 'to_id', 'toId'],
      content: ['message', 'text', 'body'],
      sent_at: ['sentDate', 'sent_date', 'created_at', 'createdAt', 'date', 'timestamp'],
    },
  },
  {
    table: 'Favorit',
    create: `CREATE TABLE Favorit (
      favoritId INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      fileId INT NOT NULL,
      UNIQUE KEY uniq_favorit_user_file (userId, fileId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      favoritId: 'INT AUTO_INCREMENT PRIMARY KEY',
      userId: 'INT NOT NULL',
      fileId: 'INT NOT NULL',
    },
  },
  {
    table: 'Admin',
    create: `CREATE TABLE Admin (
      adminId INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    columns: {
      adminId: 'INT AUTO_INCREMENT PRIMARY KEY',
      username: 'VARCHAR(50) NOT NULL',
      password: 'VARCHAR(255) NOT NULL',
    },
  },
];

console.log('\n=============================================');
console.log(` Student Helper - database repair ${APPLY ? '(APPLYING CHANGES)' : '(dry run)'}`);
console.log('=============================================\n');

let connection;
try {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
} catch (error) {
  console.error(`Could not connect to the database: ${error.message}`);
  console.error('Check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in your .env, then try again.\n');
  process.exit(1);
}

const [existingTables] = await connection.query('SHOW TABLES');
const tableNames = new Map(
  existingTables.map((row) => {
    const name = Object.values(row)[0];
    return [name.toLowerCase(), name];
  })
);

let pending = 0;
let applied = 0;

for (const spec of SCHEMA) {
  const realName = tableNames.get(spec.table.toLowerCase());

  if (!realName) {
    if (APPLY) {
      await connection.query(spec.create);
      did(`created table "${spec.table}"`);
      applied += 1;
    } else {
      todo(`table "${spec.table}" does not exist and would be created`);
      pending += 1;
    }
    continue;
  }

  const [cols] = await connection.query(`SHOW COLUMNS FROM \`${realName}\``);
  const have = new Set(cols.map((c) => c.Field.toLowerCase()));
  const missing = [];

  for (const [column, definition] of Object.entries(spec.columns)) {
    if (have.has(column.toLowerCase())) continue;

    // An older name carrying the same data? Leave the data alone and say so.
    const alias = (spec.aliases?.[column] || []).find((a) => have.has(a.toLowerCase()));
    if (alias) {
      warn(`"${realName}"."${column}" is named "${alias}" here - the app reads it either way, nothing changed`);
      continue;
    }
    missing.push([column, definition]);
  }

  if (missing.length === 0) {
    ok(`table "${realName}" has every column the app needs`);
    continue;
  }

  for (const [column, definition] of missing) {
    if (!APPLY) {
      todo(`"${realName}" is missing column "${column}" (${definition})`);
      pending += 1;
      continue;
    }
    try {
      await connection.query(`ALTER TABLE \`${realName}\` ADD COLUMN \`${column}\` ${definition}`);
      did(`added "${realName}"."${column}"`);
      applied += 1;
    } catch (error) {
      // Most likely cause: adding an AUTO_INCREMENT PRIMARY KEY to a table
      // that already has a different primary key. That needs a human decision
      // about the existing key, so it is reported rather than forced.
      warn(`could not add "${realName}"."${column}": ${error.message}`);
      warn('        this one needs to be done by hand - tell whoever maintains the database');
    }
  }
}

// A category list that is completely empty makes the upload form look broken
// on a fresh install, even though nothing is actually wrong.
const [[{ categoryCount }]] = await connection.query('SELECT COUNT(*) AS categoryCount FROM Categories');
if (categoryCount === 0) {
  if (APPLY) {
    await connection.query(
      'INSERT INTO Categories (name) VALUES (?), (?), (?), (?), (?), (?)',
      ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Computer Science', 'English']
    );
    did('seeded six starter categories (you can add more from the upload page)');
    applied += 1;
  } else {
    todo('Categories is empty - six starter categories would be added');
    pending += 1;
  }
}

await connection.end();

console.log('\n=============================================');
if (APPLY) {
  console.log(applied === 0
    ? ' Nothing needed changing - the database already matches the app.'
    : ` Done: ${applied} change(s) applied. Restart the server, then run "npm run diagnose".`);
} else if (pending === 0) {
  console.log(' Nothing to repair - the database already matches the app.');
} else {
  console.log(` ${pending} thing(s) would be changed.`);
  console.log(' Nothing has been modified. To apply them, run:');
  console.log('   npm run db:repair -- --apply');
}
console.log('=============================================\n');
