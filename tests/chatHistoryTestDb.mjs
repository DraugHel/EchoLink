import Database from 'better-sqlite3'

export function makeHistoryDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      archived_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      chat_history_sources TEXT DEFAULT '',
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE message_search
    USING fts5(
      message_id UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER message_search_ai
    AFTER INSERT ON messages BEGIN
      INSERT INTO message_search(message_id, content)
      VALUES (new.id, new.content);
    END;
    CREATE TRIGGER message_search_ad
    AFTER DELETE ON messages BEGIN
      DELETE FROM message_search WHERE message_id = old.id;
    END;
    CREATE TRIGGER message_search_au
    AFTER UPDATE OF content ON messages BEGIN
      DELETE FROM message_search WHERE message_id = old.id;
      INSERT INTO message_search(message_id, content)
      VALUES (new.id, new.content);
    END;
  `)
  db.prepare('INSERT INTO users(id, username) VALUES (?, ?)').run(1, 'one')
  db.prepare('INSERT INTO users(id, username) VALUES (?, ?)').run(2, 'two')
  db.prepare('INSERT INTO conversations(id, user_id, title, archived_at) VALUES (?, ?, ?, ?)')
    .run(10, 1, 'Scarlett und Guitarix', null)
  db.prepare('INSERT INTO conversations(id, user_id, title, archived_at) VALUES (?, ?, ?, ?)')
    .run(11, 1, 'Alter archivierter Chat', 2000)
  db.prepare('INSERT INTO conversations(id, user_id, title, archived_at) VALUES (?, ?, ?, ?)')
    .run(20, 2, 'Fremder Scarlett-Chat', null)

  const insert = db.prepare(`
    INSERT INTO messages(id, conversation_id, role, content, images, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insert.run(101, 10, 'user', 'Der Scarlett Kopfhörer ist nur links zu hören.', '', 1000)
  insert.run(102, 10, 'assistant', 'Vielleicht ist Guitarix falsch geroutet.', '', 1010)
  insert.run(103, 10, 'user', 'Korrektur: Direct Monitor ist okay, Guitarix kommt rechts.', '', 1020)
  insert.run(104, 10, 'assistant', '**Terminal:** pw-link -l zeigte die Ports.', '', 1030)
  insert.run(105, 10, 'user', 'Die Lösung war am Ende der Mono-zu-Stereo-Routing-Schritt.', JSON.stringify([{ originalName: 'routing.png', kind: 'image' }]), 1040)
  insert.run(111, 11, 'user', 'Guitarix links im archivierten Verlauf.', '', 900)
  insert.run(201, 20, 'user', 'Scarlett Guitarix fremder geheimer Text.', '', 1005)
  return db
}
