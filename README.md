# Student Helper

Student Helper is a web-based platform designed to facilitate resource sharing and communication among students. It allows users to upload study materials, chat about specific files, and connect with peers.

## Features

*   **Resource Sharing**: Upload and categorize study materials.
*   **File-based Chat**: Discuss specific resources in dedicated chat rooms.
*   **Direct Messaging**: Send private messages to other students.
*   **Favorites**: Save important files for quick access.
*   **Admin Dashboard**: Manage users and content.

## Screenshots

### Add File
![Add File Page](photos/addfile.png)

### Admin Dashboard
![Admin Dashboard](photos/admin.png)

### AI Study Buddy
![AI Study Buddy](photos/AI.png)

### My Files
![My Files](photos/forme.png)

## Tech Stack

*   **Frontend**: HTML, EJS, TailwindCSS
*   **Backend**: Node.js, Express.js
*   **Database**: MySQL
*   **Authentication**: Express Session

## Getting Started

### Prerequisites

*   Node.js
*   MySQL

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/yourusername/student-helper.git
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Configure the database:
    *   Import `student_helper_db.sql` into your MySQL server.
    *   Create a `.env` file in the root directory (see `.env.example` or use the template below).

4.  Set up environment variables (`.env`):
    ```env
    DB_HOST=localhost
    DB_USER=root
    DB_PASSWORD=your_password
    DB_NAME=Student_Helper2_DB
    SESSION_SECRET=your_secret_key
    PORT=3002
    ```

5.  Start the server:
    ```bash
    npm start
    ```

6.  Visit `http://localhost:3002` in your browser.

## Project Structure

*   `app.js`: Main application entry point.
*   `routes/`: API routes and page controllers.
*   `models/`: Database connections and models.
*   `public/`: Static assets (CSS, JS, images).
*   `views/`: HTML/EJS templates.

## License

This project is licensed under the ISC License.
