const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'society_tracker_secret_token_xyz_123';
const ADMIN_SETUP_CODE = process.env.ADMIN_SETUP_CODE || 'admin_pass_2026';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static directories setup
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

// Multer photo upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}_${safeName}`);
  }
});
const upload = multer({ storage });

// Database initialization
let db = null;
async function initDb() {
  const dbPath = path.resolve(__dirname, 'database.sqlite');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.run('PRAGMA foreign_keys = ON;');

  // Schema creation
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('resident', 'admin')),
      unit_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS complaints (
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

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_important INTEGER DEFAULT 0 CHECK(is_important IN (0, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed settings
  const threshold = await db.get("SELECT value FROM settings WHERE key = 'overdue_days_threshold'");
  if (!threshold) {
    await db.run("INSERT INTO settings (key, value) VALUES ('overdue_days_threshold', '3')");
  }

  // Seed users
  const userCount = await db.get("SELECT count(*) as count FROM users");
  if (userCount.count === 0) {
    const adminPasswordHash = bcrypt.hashSync('admin123', 10);
    const residentPasswordHash = bcrypt.hashSync('resident123', 10);

    const adminResult = await db.run(
      `INSERT INTO users (username, email, password_hash, role, unit_number) VALUES (?, ?, ?, ?, ?)`,
      ['admin', 'admin@society.com', adminPasswordHash, 'admin', null]
    );

    const residentResult = await db.run(
      `INSERT INTO users (username, email, password_hash, role, unit_number) VALUES (?, ?, ?, ?, ?)`,
      ['resident', 'resident@society.com', residentPasswordHash, 'resident', 'A-104']
    );

    const adminId = adminResult.lastID;
    const residentId = residentResult.lastID;

    // Seed Notices
    await db.run(
      `INSERT INTO notices (admin_id, title, content, is_important) VALUES (?, 'Water Supply Maintenance Scheduled', 'Please note that water supply will be suspended this Saturday from 10:00 AM to 2:00 PM for water tank cleaning.', 1)`,
      [adminId]
    );
    await db.run(
      `INSERT INTO notices (admin_id, title, content, is_important) VALUES (?, 'Annual General Meeting (AGM) Notice', 'The AGM of the society will be held on July 12th in the Clubhouse. Attendance is requested.', 0)`,
      [adminId]
    );

    // Seed Complaints
    const comp1 = await db.run(
      `INSERT INTO complaints (resident_id, category, description, status, priority, created_at) VALUES (?, 'Plumbing', 'Water leaking from the kitchen sink joint in unit A-104.', 'Open', 'High', datetime('now', '-5 days'))`,
      [residentId]
    );
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note, created_at) VALUES (?, 'Open', ?, 'Complaint created by resident.', datetime('now', '-5 days'))`,
      [comp1.lastID, residentId]
    );

    const comp2 = await db.run(
      `INSERT INTO complaints (resident_id, category, description, status, priority, created_at) VALUES (?, 'Electrical', 'Elevator B corridor lights are flickering and need bulb replacement.', 'In Progress', 'Medium', datetime('now', '-1 day'))`,
      [residentId]
    );
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note, created_at) VALUES (?, 'Open', ?, 'Complaint created by resident.', datetime('now', '-1 day'))`,
      [comp2.lastID, residentId]
    );
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note, created_at) VALUES (?, 'In Progress', ?, 'Technician assigned to inspect bulb replacement.', datetime('now', '-12 hours'))`,
      [comp2.lastID, adminId]
    );
  }
  console.log('Database initialized successfully.');
}

// Notification Helper
async function sendEmailNotification({ to, subject, text }) {
  try {
    await db.run(
      `INSERT INTO mock_emails (to_email, subject, content) VALUES (?, ?, ?)`,
      [to, subject, text]
    );
  } catch (err) {
    console.error('Failed to log mock email:', err);
  }

  console.log(`\n========================================`);
  console.log(`[EMAIL NOTIFICATION SENT]`);
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Content: ${text}`);
  console.log(`========================================\n`);

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || '587';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'no-reply@societymaintenance.com';

  if (host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: parseInt(port, 10),
        secure: parseInt(port, 10) === 465,
        auth: { user, pass },
      });
      await transporter.sendMail({ from, to, subject, text });
      console.log(`Real email sent successfully to ${to}`);
    } catch (error) {
      console.error('Error sending real email via SMTP:', error);
    }
  }
}

// Auth Middleware
function authenticate(req, res, next) {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired. Please log in.' });
  }
}

// --- AUTH API ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, role, unit_number, admin_code } = req.body;
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const trimmedUsername = username.trim().toLowerCase();
    const trimmedEmail = email.trim().toLowerCase();

    if (role !== 'resident' && role !== 'admin') {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (role === 'resident' && (!unit_number || !unit_number.trim())) {
      return res.status(400).json({ error: 'Unit number is required for residents.' });
    }
    if (role === 'admin' && admin_code !== ADMIN_SETUP_CODE) {
      return res.status(400).json({ error: 'Invalid admin setup code.' });
    }

    const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [trimmedUsername, trimmedEmail]);
    if (existing) {
      return res.status(400).json({ error: 'Username or email already in use.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, role, unit_number) VALUES (?, ?, ?, ?, ?)`,
      [trimmedUsername, trimmedEmail, passwordHash, role, role === 'resident' ? unit_number.trim() : null]
    );

    const safeUser = { id: result.lastID, username: trimmedUsername, email: trimmedEmail, role, unit_number };
    const token = jwt.sign(safeUser, JWT_SECRET, { expiresIn: '1d' });

    res.cookie('token', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    return res.status(201).json({ user: safeUser });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const identifier = emailOrUsername.trim().toLowerCase();
    const user = await db.get('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const safeUser = { id: user.id, username: user.username, email: user.email, role: user.role, unit_number: user.unit_number };
    const token = jwt.sign(safeUser, JWT_SECRET, { expiresIn: '1d' });

    res.cookie('token', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    return res.status(200).json({ user: safeUser });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  return res.status(200).json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ user: decoded });
  } catch (_) {
    return res.status(401).json({ error: 'Invalid session.' });
  }
});

// --- COMPLAINTS API ROUTES ---
app.get('/api/complaints', authenticate, async (req, res) => {
  try {
    const { category, status, date } = req.query;
    
    const thresholdRow = await db.get("SELECT value FROM settings WHERE key = 'overdue_days_threshold'");
    const thresholdDays = parseInt(thresholdRow?.value || '3', 10);
    const thresholdSeconds = thresholdDays * 86400;

    if (req.user.role === 'admin') {
      let query = `
        SELECT c.*, u.username as resident_name, u.unit_number,
          (c.status != 'Resolved' AND (strftime('%s', 'now') - strftime('%s', c.created_at)) > ?) as is_overdue
        FROM complaints c
        JOIN users u ON c.resident_id = u.id
      `;
      const params = [thresholdSeconds];
      const conditions = [];

      if (category && category !== 'All') {
        conditions.push("c.category = ?");
        params.push(category);
      }
      if (status && status !== 'All') {
        conditions.push("c.status = ?");
        params.push(status);
      }
      if (date) {
        conditions.push("date(c.created_at) = ?");
        params.push(date);
      }

      if (conditions.length > 0) {
        query += " AND " + conditions.join(" AND ");
      }
      query += " ORDER BY is_overdue DESC, c.created_at DESC";

      const complaints = await db.all(query, params);

      // Attach history to each
      for (let comp of complaints) {
        comp.is_overdue = Boolean(comp.is_overdue);
        comp.history = await db.all(
          `SELECT sh.*, u.username as actor_name, u.role as actor_role 
           FROM status_history sh JOIN users u ON sh.actor_id = u.id 
           WHERE sh.complaint_id = ? ORDER BY sh.created_at DESC`,
          [comp.id]
        );
      }
      return res.status(200).json({ complaints });
    } else {
      // Resident: see only own complaints
      const complaints = await db.all(
        `SELECT c.*, 
          (c.status != 'Resolved' AND (strftime('%s', 'now') - strftime('%s', c.created_at)) > ?) as is_overdue
         FROM complaints c WHERE c.resident_id = ? ORDER BY c.created_at DESC`,
        [thresholdSeconds, req.user.id]
      );

      for (let comp of complaints) {
        comp.is_overdue = Boolean(comp.is_overdue);
        comp.history = await db.all(
          `SELECT sh.*, u.username as actor_name, u.role as actor_role 
           FROM status_history sh JOIN users u ON sh.actor_id = u.id 
           WHERE sh.complaint_id = ? ORDER BY sh.created_at DESC`,
          [comp.id]
        );
      }
      return res.status(200).json({ complaints });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch complaints.' });
  }
});

app.post('/api/complaints', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (req.user.role !== 'resident') {
      return res.status(403).json({ error: 'Only residents can raise complaints.' });
    }
    const { category, description } = req.body;
    if (!category || !description) {
      return res.status(400).json({ error: 'Category and description are required.' });
    }

    let photoUrl = null;
    if (req.file) {
      photoUrl = `/uploads/${req.file.filename}`;
    }

    const result = await db.run(
      `INSERT INTO complaints (resident_id, category, description, photo_url, status, priority) VALUES (?, ?, ?, ?, 'Open', 'Medium')`,
      [req.user.id, category, description.trim(), photoUrl]
    );

    const complaintId = result.lastID;
    await db.run(
      `INSERT INTO status_history (complaint_id, status, actor_id, note) VALUES (?, 'Open', ?, 'Complaint created by resident.')`,
      [complaintId, req.user.id]
    );

    return res.status(201).json({ success: true, complaintId });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create complaint.' });
  }
});

app.get('/api/complaints/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const complaint = await db.get(
      `SELECT c.*, u.username as resident_name, u.email as resident_email, u.unit_number 
       FROM complaints c JOIN users u ON c.resident_id = u.id WHERE c.id = ?`,
      [id]
    );

    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });
    if (req.user.role !== 'admin' && complaint.resident_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    complaint.history = await db.all(
      `SELECT sh.*, u.username as actor_name, u.role as actor_role 
       FROM status_history sh JOIN users u ON sh.actor_id = u.id 
       WHERE sh.complaint_id = ? ORDER BY sh.created_at DESC`,
      [id]
    );
    return res.status(200).json({ complaint });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to retrieve complaint details.' });
  }
});

app.patch('/api/complaints/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can modify complaints.' });
    }
    const { id } = req.params;
    const { status, priority, note } = req.body;

    const complaint = await db.get(
      `SELECT c.*, u.username as resident_name, u.email as resident_email 
       FROM complaints c JOIN users u ON c.resident_id = u.id WHERE c.id = ?`,
      [id]
    );
    if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

    await db.run('BEGIN TRANSACTION');

    let statusUpdated = false;
    if (priority && ['Low', 'Medium', 'High'].includes(priority)) {
      await db.run(`UPDATE complaints SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [priority, id]);
    }
    if (status && ['Open', 'In Progress', 'Resolved'].includes(status)) {
      if (complaint.status !== status) {
        await db.run(`UPDATE complaints SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, id]);
        await db.run(
          `INSERT INTO status_history (complaint_id, status, actor_id, note) VALUES (?, ?, ?, ?)`,
          [id, status, req.user.id, note || `Status updated to ${status} by Admin.`]
        );
        statusUpdated = true;
      }
    }

    await db.run('COMMIT');

    if (statusUpdated) {
      const emailText = `Hi ${complaint.resident_name},\n\nThe status of your complaint regarding "${complaint.category}" (Complaint #${id}) has been updated to "${status}".${note ? `\n\nAdmin Note: "${note}"` : ''}\n\nBest regards,\nSociety Management Team`;
      await sendEmailNotification({
        to: complaint.resident_email,
        subject: `Update on complaint #${id}: ${status}`,
        text: emailText
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    await db.run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Failed to update complaint.' });
  }
});

// --- NOTICES API ROUTES ---
app.get('/api/notices', authenticate, async (req, res) => {
  try {
    const notices = await db.all(
      `SELECT n.*, u.username as admin_name FROM notices n 
       JOIN users u ON n.admin_id = u.id ORDER BY n.is_important DESC, n.created_at DESC`
    );
    return res.status(200).json({ notices: notices.map(n => ({ ...n, is_important: Boolean(n.is_important) })) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch notices.' });
  }
});

app.post('/api/notices', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can post notices.' });
    }
    const { title, content, is_important } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required.' });
    }

    const importantVal = is_important ? 1 : 0;
    await db.run(
      `INSERT INTO notices (admin_id, title, content, is_important) VALUES (?, ?, ?, ?)`,
      [req.user.id, title.trim(), content.trim(), importantVal]
    );

    if (is_important) {
      const residents = await db.all("SELECT email, username FROM users WHERE role = 'resident'");
      for (const resident of residents) {
        const emailText = `Hi ${resident.username},\n\nA new important notice has been posted: "${title}"\n\n${content}\n\nLog in to the Society Maintenance Tracker to read the details.\n\nBest regards,\nSociety Management Team`;
        sendEmailNotification({
          to: resident.email,
          subject: `⚠️ Important Announcement: ${title}`,
          text: emailText
        }).catch(err => console.error(err));
      }
    }
    return res.status(201).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to post notice.' });
  }
});

// --- SETTINGS API ---
app.get('/api/settings', authenticate, async (req, res) => {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'overdue_days_threshold'");
    return res.status(200).json({ overdue_days_threshold: parseInt(row?.value || '3', 10) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

app.post('/api/settings', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update settings.' });
    }
    const { overdue_days_threshold } = req.body;
    const thresholdVal = parseInt(overdue_days_threshold, 10);
    if (isNaN(thresholdVal) || thresholdVal < 0) {
      return res.status(400).json({ error: 'Threshold must be a non-negative number.' });
    }

    await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('overdue_days_threshold', ?)`, [thresholdVal.toString()]);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// --- MOCK EMAILS API ---
app.get('/api/mock-emails', async (req, res) => {
  try {
    const emails = await db.all("SELECT * FROM mock_emails ORDER BY sent_at DESC");
    return res.status(200).json({ emails });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch mock emails.' });
  }
});

app.delete('/api/mock-emails', async (req, res) => {
  try {
    await db.run("DELETE FROM mock_emails");
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to clear mock inbox.' });
  }
});

// Root Route: Redirects depending on auth/role
app.get('/', (req, res) => {
  const token = req.cookies.token;
  if (!token) {
    return res.redirect('/login.html');
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'admin') {
      return res.redirect('/admin.html');
    } else {
      return res.redirect('/index.html');
    }
  } catch (error) {
    res.clearCookie('token');
    return res.redirect('/login.html');
  }
});

// Start Server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});
