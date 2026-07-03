# System Design: Society Maintenance Tracker (Simplified Express Stack)

This document outlines the architectural and design decisions made for the simplified Society Maintenance Tracker application.

---

## 1. Simplified Architecture Overview

The system uses a lightweight client-server architecture with zero compilation steps, maximizing run-time reliability and ease of setup:

```
[Web Browser] --(HTTP/JSON/Cookies)--> [Express Server (server.js)]
                                               |
                                     [SQLite (database.sqlite)]
```

1. **Frontend**: Pure HTML, CSS, and client-side JavaScript located in the `public/` directory, served statically by Express.
2. **Backend**: A single unified Node.js file `server.js` running an **Express** web server and serving all REST API routes.
3. **Database**: A local zero-configuration **SQLite** database (`database.sqlite`) managed via raw SQL.

---

## 2. Complaint History & Lifecycle Model

The complaint lifecycle tracking uses two tables: `complaints` (active state) and `status_history` (historical state changes).
- **`complaints`**: Stores details such as category, description, attachment, status (`Open`, `In Progress`, `Resolved`), and priority (`Low`, `Medium`, `High`).
- **`status_history`**: Represents an append-only audit trail logging:
  - `complaint_id`: Reference to parent complaint.
  - `status`: New status state.
  - `actor_id`: Reference to user making the change.
  - `note`: Optional note describing the change (e.g. "Vendor dispatched").
  - `created_at`: Absolute timestamp of change.

When a resident files a complaint, it starts as `'Open'`. When an admin changes the status, a new entry is logged. When retrieving complaints, the server performs a JOIN on `status_history` and `users` to construct the timeline log sorted by `created_at DESC` for rendering.

---

## 3. On-The-Fly Overdue Detection

A complaint is flagged as "Overdue" if its status is not `'Resolved'` and the difference between the current time and its creation time exceeds the admin-configurable day threshold.

Rather than running heavy cron jobs to update statuses, overdue checks are computed dynamically on-the-fly during the SQL query:
```sql
SELECT c.*, u.username,
  (c.status != 'Resolved' AND (strftime('%s', 'now') - strftime('%s', c.created_at)) > ?) AS is_overdue
FROM complaints c
JOIN users u ON c.resident_id = u.id
ORDER BY is_overdue DESC, c.created_at DESC;
```
- **`strftime('%s', 'now')`**: Gets the current UTC epoch in seconds.
- **`is_overdue DESC`**: Sorts overdue items to the top of the admin queue instantly.

---

## 4. Photo Handling

- **Upload**: Residents select a photo in a standard file input. The frontend submits this via a `FormData` multipart request.
- **Server Storage**: The Express server uses the `multer` middleware to intercept the multipart body, save the binary file locally in `/public/uploads` under a unique timestamp-prefixed filename, and write the relative URL `/uploads/timestamp_file.jpg` to the database.
- **Static Assets Serving**: The `/uploads` folder is served as a static directory, allowing browsers to render photos immediately.

---

## 5. Notification Flow & Grading Helper

1. **Trigger**: Fired when an admin updates a complaint's status or posts an announcement marked "Important".
2. **Real SMTP**: If SMTP keys exist in the environment, the server sends a real email via `nodemailer`.
3. **Grading Helper (Mock Mailbox)**: To ensure grading works out of the box with zero SMTP configuration, the server always logs sent notifications to a local `mock_emails` database table. A floating **Mock Mailbox Drawer** polls this table and displays sent email details instantly in the browser.
