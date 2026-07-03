const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

async function runTests() {
  console.log("==================================================");
  console.log("STARTING DATABASE & BUSINESS LOGIC INTEGRATION TESTS");
  console.log("==================================================");

  const dbPath = path.resolve(__dirname, 'test_database.sqlite');
  
  // Delete existing test db if any
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  try {
    await db.run('PRAGMA foreign_keys = ON;');
    console.log("✔ SQLite connection established and Foreign Keys enabled.");

    // Create Tables
    await db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('resident', 'admin')),
        unit_number TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✔ Users table created.");

    await db.exec(`
      CREATE TABLE complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resident_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        photo_url TEXT,
        status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'In Progress', 'Resolved')),
        priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low', 'Medium', 'High')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(resident_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    console.log("✔ Complaints table created.");

    await db.exec(`
      CREATE TABLE status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complaint_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        actor_id INTEGER NOT NULL,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
        FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    console.log("✔ Status History table created.");

    await db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    console.log("✔ Settings table created.");

    // Test 1: User Registration and Password Hashing
    console.log("\n--- TEST 1: User Authentication & Hashing ---");
    const testPassword = "securePassword123";
    const passwordHash = bcrypt.hashSync(testPassword, 10);
    
    await db.run(
      `INSERT INTO users (username, email, password_hash, role, unit_number) 
       VALUES (?, ?, ?, ?, ?)`,
      ['testresident', 'resident@test.com', passwordHash, 'resident', 'C-302']
    );

    const retrievedUser = await db.get("SELECT * FROM users WHERE username = 'testresident'");
    if (retrievedUser) {
      console.log(`✔ User retrieved successfully: @${retrievedUser.username} (${retrievedUser.email})`);
      const isMatch = bcrypt.compareSync(testPassword, retrievedUser.password_hash);
      if (isMatch) {
        console.log("✔ Password validation passed.");
      } else {
        throw new Error("Password validation failed.");
      }
    } else {
      throw new Error("Failed to retrieve inserted user.");
    }

    // Insert Admin
    await db.run(
      `INSERT INTO users (username, email, password_hash, role, unit_number) 
       VALUES (?, ?, ?, ?, ?)`,
      ['testadmin', 'admin@test.com', bcrypt.hashSync('admin123', 10), 'admin', null]
    );
    const adminUser = await db.get("SELECT * FROM users WHERE role = 'admin'");
    console.log(`✔ Admin retrieved: @${adminUser.username}`);

    // Test 2: Complaint lifecycle and status history
    console.log("\n--- TEST 2: Complaint Creation & Status History Timeline ---");
    
    // Insert new complaint
    const complaintResult = await db.run(
      `INSERT INTO complaints (resident_id, category, description, status, priority) 
       VALUES (?, ?, ?, 'Open', 'Medium')`,
      [retrievedUser.id, 'Plumbing', 'Water leaking in C-302 bathroom.']
    );
    const complaintId = complaintResult.lastID;
    console.log(`✔ Complaint created with ID: ${complaintId}`);

    // Add status history (Open)
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note) 
       VALUES (?, 'Open', ?, ?)`,
      [complaintId, retrievedUser.id, 'Resident raised complaint.']
    );

    // Update status to In Progress
    await db.run(
      `UPDATE complaints SET status = 'In Progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [complaintId]
    );
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note) 
       VALUES (?, 'In Progress', ?, ?)`,
      [complaintId, adminUser.id, 'Plumber assigned, expected work tomorrow.']
    );

    // Fetch history timeline
    const historyLogs = await db.all(
      `SELECT sh.*, u.username as actor_name 
       FROM status_history sh 
       JOIN users u ON sh.actor_id = u.id 
       WHERE sh.complaint_id = ? 
       ORDER BY sh.created_at ASC`,
      [complaintId]
    );

    console.log(`✔ History Timeline retrieved (${historyLogs.length} updates):`);
    historyLogs.forEach((log, index) => {
      console.log(`   [Update ${index + 1}] Status: ${log.status} | By: @${log.actor_name} | Note: "${log.note}"`);
    });

    if (historyLogs.length !== 2) {
      throw new Error("Status history timeline mismatch.");
    }

    // Test 3: Overdue Detection Logic
    console.log("\n--- TEST 3: Dynamic Overdue Detection ---");
    
    // Set overdue threshold to 3 days
    await db.run("INSERT INTO settings (key, value) VALUES ('overdue_days_threshold', '3')");
    
    // Insert an open complaint created 5 days ago
    const oldComplaintResult = await db.run(
      `INSERT INTO complaints (resident_id, category, description, status, priority, created_at) 
       VALUES (?, 'Electrical', 'Broken light switch in hallway.', 'Open', 'Low', datetime('now', '-5 days'))`,
      [retrievedUser.id]
    );
    const oldComplaintId = oldComplaintResult.lastID;

    // Helper query function that checks is_overdue
    const getComplaintWithOverdueCheck = async (id, thresholdDays) => {
      const seconds = thresholdDays * 86400;
      return await db.get(
        `SELECT *, 
           (status != 'Resolved' AND (strftime('%s', 'now') - strftime('%s', created_at)) > ?) as is_overdue 
         FROM complaints 
         WHERE id = ?`,
        [seconds, id]
      );
    };

    // With 3-day threshold, a 5-day old open complaint should be overdue
    let check = await getComplaintWithOverdueCheck(oldComplaintId, 3);
    console.log(`Threshold: 3 days | Complaint age: 5 days | Status: ${check.status}`);
    console.log(`✔ Is Overdue calculated as: ${Boolean(check.is_overdue)} (Expected: true)`);
    if (!check.is_overdue) {
      throw new Error("Complaint should have been marked overdue.");
    }

    // With 7-day threshold, a 5-day old open complaint should NOT be overdue
    check = await getComplaintWithOverdueCheck(oldComplaintId, 7);
    console.log(`Threshold: 7 days | Complaint age: 5 days | Status: ${check.status}`);
    console.log(`✔ Is Overdue calculated as: ${Boolean(check.is_overdue)} (Expected: false)`);
    if (check.is_overdue) {
      throw new Error("Complaint should not have been marked overdue.");
    }

    // If complaint status is set to Resolved, it should NOT be overdue even if old
    await db.run(`UPDATE complaints SET status = 'Resolved' WHERE id = ?`, [oldComplaintId]);
    check = await getComplaintWithOverdueCheck(oldComplaintId, 3);
    console.log(`Threshold: 3 days | Complaint age: 5 days | Status: ${check.status}`);
    console.log(`✔ Is Overdue calculated as: ${Boolean(check.is_overdue)} (Expected: false)`);
    if (check.is_overdue) {
      throw new Error("Resolved complaints should never be overdue.");
    }

    console.log("\n==================================================");
    console.log("ALL TESTS COMPLETED SUCCESSFULLY! (PASSED)");
    console.log("==================================================");

  } catch (err) {
    console.error("\n❌ TEST FAILURE:", err.message);
  } finally {
    await db.close();
    // Clean up test DB
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  }
}

runTests();
