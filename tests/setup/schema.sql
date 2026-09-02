-- Test-database schema for Student Helper.
-- Inferred from the SQL queries in models/*.js (the repo has no committed
-- schema.sql/student_helper_db.sql to copy from). This runs ONLY against the
-- isolated test database created by tests/setup/testDb.js - it never touches
-- your real development database. If your actual schema differs (extra
-- columns, different constraints), integration tests will point at exactly
-- which query failed so it's easy to reconcile.

CREATE TABLE IF NOT EXISTS Users (
  userId INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  categoryID INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  uploadedBy INT NOT NULL,
  FOREIGN KEY (categoryID) REFERENCES Categories(id) ON DELETE CASCADE,
  FOREIGN KEY (uploadedBy) REFERENCES Users(userId) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Semantic-search vectors. Created at runtime too (models/FileEmbedding.js
-- issues the same CREATE TABLE IF NOT EXISTS on first use), so a development
-- database picks it up without a migration step. Kept out of Files on purpose:
-- a vector is a kilobyte of JSON that no ordinary query wants to read.
CREATE TABLE IF NOT EXISTS FileEmbeddings (
  fileId INT NOT NULL PRIMARY KEY,
  model VARCHAR(64) NOT NULL,
  dimensions INT NOT NULL,
  vector LONGTEXT NOT NULL,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_file_embedding_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Uploaded file bytes, for FILE_STORAGE=database (every free host has a
-- throwaway filesystem). Created at runtime too by models/FileBlob.js.
-- Chunked because TiDB caps one row at 6 MiB and the serverless tier will not
-- let you raise it, so a 10 MB upload cannot be a single LONGBLOB.
CREATE TABLE IF NOT EXISTS FileBlobs (
  fileId INT NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  mimeType VARCHAR(120) NOT NULL,
  byteSize INT NOT NULL,
  chunkCount INT NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fileblob_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS FileBlobChunks (
  fileId INT NOT NULL,
  seq INT NOT NULL,
  bytes LONGBLOB NOT NULL,
  PRIMARY KEY (fileId, seq),
  CONSTRAINT fk_fileblobchunk_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fileID INT NOT NULL,
  content VARCHAR(1000) NOT NULL,
  userID INT NOT NULL,
  chatDate TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fileID) REFERENCES Files(id) ON DELETE CASCADE,
  FOREIGN KEY (userID) REFERENCES Users(userId) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Direct messages. models/Message.js reads THIS table by name (adapting to
-- whatever column names it finds), so it has to exist for messaging to work.
-- It was missing from this file: the messages tests only ever passed because
-- an earlier run of `npm run db:repair` had left the table behind in whatever
-- database the suite happened to reuse. On a genuinely fresh database every
-- one of them failed with 503 SCHEMA_MISMATCH.
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content VARCHAR(1000) NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES Users(userId) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES Users(userId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages_chat (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content VARCHAR(1000) NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES Users(userId) ON DELETE CASCADE,
  FOREIGN KEY (receiver_id) REFERENCES Users(userId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Favorit (
  favoritId INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  fileId INT NOT NULL,
  -- Backs the "already favorited?" check in models/Favorite.js#add. That check
  -- is a SELECT followed by an INSERT; without this constraint two requests
  -- that interleave between the two statements BOTH insert, and the file shows
  -- up twice in the favorites list (reproduced with 3 concurrent requests).
  -- The application check stays as the fast path; this makes it actually safe.
  UNIQUE KEY uniq_favorit_user_file (userId, fileId),
  FOREIGN KEY (userId) REFERENCES Users(userId) ON DELETE CASCADE,
  FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Admin (
  adminId INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userID INT NOT NULL,
  content VARCHAR(1000) NOT NULL,
  FOREIGN KEY (userID) REFERENCES Users(userId) ON DELETE CASCADE
) ENGINE=InnoDB;
