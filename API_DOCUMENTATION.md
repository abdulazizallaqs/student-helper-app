# Student Helper API Documentation

## Base URL
```
http://localhost:3002
```

## Authentication
Most endpoints require session-based authentication. Users must log in to access protected routes.

---

## Authentication Endpoints

### POST /
**Description**: User login  
**Rate Limit**: 5 requests per 15 minutes  
**Body**:
```json
{
  "username": "string (required)",
  "password": "string (required)"
}
```
**Success Response**: Redirects to `/views/file-page-forme.html` (the signed-in landing page; see `config/appRoutes.js`)  
**Error Response**: Redirects to `/?error=message`

### POST /create-account
**Description**: Create a new user account  
**Body**:
```json
{
  "name": "string (2-100 chars, letters only)",
  "username": "string (3-50 chars, alphanumeric)",
  "email": "string (valid email)",
  "password": "string (min 6 chars, must contain uppercase, lowercase, number)"
}
```
**Success Response**: Account created, redirects to login  
**Error Response**: 400 with validation errors

---

## File Management Endpoints

### GET /categories
**Description**: Get all file categories  
**Auth**: Not required  
**Response**:
```json
[
  {
    "id": 1,
    "name": "Category Name"
  }
]
```

### POST /upload-note
**Description**: Upload a new file  
**Auth**: Required  
**Content-Type**: multipart/form-data  
**Body**:
- `file`: PDF file (max 10MB)
- `title`: string (3-100 chars)
- `description`: string (max 500 chars)
- `category`: integer (category ID)

**Success Response**: Redirects to add-file page  
**Error Response**: 400/401/500

### GET /my-files
**Description**: Get files uploaded by the logged-in user  
**Auth**: Required  
**Response**:
```json
[
  {
    "id": 1,
    "title": "File Title",
    "description": "File Description",
    "username": "uploader",
    "category": "Category Name"
  }
]
```

### GET /files-for-me
**Description**: Get files uploaded by other users  
**Auth**: Required  
**Response**: Same as /my-files

### GET /file/:id
**Description**: Get file details by ID  
**Auth**: Not required  
**Response**:
```json
{
  "id": 1,
  "title": "File Title",
  "description": "File Description",
  "categoryID": 1,
  "uploadedBy": 1,
  "category": "Category Name"
}
```

### PUT /update-file/:id
**Description**: Update file details  
**Auth**: Required (must be file owner)  
**Body**:
```json
{
  "title2": "string (optional, 3-100 chars)",
  "description2": "string (optional, max 500 chars)",
  "category2": "integer (optional)"
}
```

### DELETE /file-page-myfile/:id
**Description**: Delete a file  
**Auth**: Required (must be file owner)  
**Success Response**: 200 with success message

### GET /search-files?query=searchterm
**Description**: Search files by title, description, or username  
**Auth**: Not required  
**Query Parameters**:
- `query`: string (1-100 chars, required)

---

## Chat Endpoints

### GET /file-chats/:fileId
**Description**: Get all chats for a specific file  
**Auth**: Not required  
**Response**:
```json
[
  {
    "content": "Chat message",
    "chatDate": "2024-01-01T00:00:00.000Z",
    "username": "user1"
  }
]
```

### POST /add-chat
**Description**: Add a chat message to a file  
**Auth**: Required  
**Body**:
```json
{
  "fileId": "integer (required)",
  "chatText": "string (1-1000 chars, required)"
}
```

---

## Messaging Endpoints

### GET /file-msg
**Description**: Get messages sent by the logged-in user  
**Auth**: Required

### GET /msg-to-me
**Description**: Get messages received by the logged-in user  
**Auth**: Required

### GET /msg
**Description**: Get all users (for messaging)  
**Auth**: Required

### POST /add-msg
**Description**: Send a direct message  
**Auth**: Required  
**Body**:
```json
{
  "receiver": "integer (user ID, required)",
  "content": "string (1-1000 chars, required)"
}
```

---

## Favorites Endpoints

### GET /favorite
**Description**: Get user's favorite files  
**Auth**: Required

### POST /add-to-favorites
**Description**: Add a file to favorites  
**Auth**: Required  
**Body**:
```json
{
  "fileId": "integer (required)"
}
```

### DELETE /favorite/:favoritId
**Description**: Remove a file from favorites  
**Auth**: Required

---

## Admin Endpoints

### POST /admin-login
**Description**: Admin login  
**Body**:
```json
{
  "username": "string (required)",
  "password": "string (required)"
}
```

### GET /admin/users
**Description**: Get all users with statistics  
**Auth**: Admin required

### GET /admin/files
**Description**: Get all files  
**Auth**: Admin required

### DELETE /admin/delete-user/:userId
**Description**: Delete a user  
**Auth**: Admin required

### DELETE /admin/delete-file/:fileId
**Description**: Delete a file  
**Auth**: Admin required

---

## Error Responses

All endpoints may return the following error responses:

- **400 Bad Request**: Invalid input data
- **401 Unauthorized**: Authentication required
- **404 Not Found**: Resource not found
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Server error

Error response format:
```json
{
  "status": "fail",
  "message": "Error description"
}
```

---

## Rate Limiting

- **General**: 100 requests per 15 minutes per IP
- **Authentication**: 5 login attempts per 15 minutes per IP

---

## Security Features

- Helmet security headers
- CORS enabled
- Input validation and sanitization
- Password hashing with bcrypt
- Session-based authentication
- File type and size restrictions
- XSS protection
