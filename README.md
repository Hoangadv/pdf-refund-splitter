# 📄 PDF Refund Splitter - Full Stack App

## 🚀 Tính năng

✅ Upload file PDF "Check Refund Backup"  
✅ Tự động tách theo LO (Location)  
✅ Tạo file PDF 3 trang cho mỗi LO:
  - Trang 1: Dòng dữ liệu LO
  - Trang 2-3: 2 trang cuối file gốc
✅ Download tất cả file dưới dạng ZIP  
✅ Tên file tự động: `MMDDYY-LOID.pdf`  

---

## 📦 Cấu trúc file

```
pdf-refund-splitter/
├── server.js              # Backend Node.js
├── package.json           # Dependencies
├── public/
│   └── index.html         # Frontend
├── .gitignore
├── README.md
└── railway.json          # Config cho Railway
```

---

## 🏃 Chạy locally

### 1️⃣ Cài đặt Node.js
Tải từ: https://nodejs.org (v18 trở lên)

### 2️⃣ Clone hoặc tải project
```bash
# Tạo thư mục mới
mkdir pdf-refund-splitter
cd pdf-refund-splitter

# Copy tất cả file vào thư mục này
# - server.js
# - package.json
# - .gitignore
# - Tạo thư mục: mkdir public
# - Copy index.html vào thư mục public/
```

### 3️⃣ Cài dependencies
```bash
npm install
```

### 4️⃣ Chạy server
```bash
# Chế độ development (auto-reload):
npm run dev

# Hoặc chế độ production:
npm start
```

Server sẽ chạy tại: **http://localhost:3000**

---

## 🚀 Deploy lên Railway (Miễn phí)

### Cách 1: Deploy từ GitHub (Dễ nhất)

**A) Tạo GitHub repo**
1. Vào https://github.com/new
2. Tên repo: `pdf-refund-splitter`
3. Chọn Public
4. Create repository

**B) Push code lên GitHub**
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pdf-refund-splitter.git
git push -u origin main
```

**C) Deploy lên Railway**
1. Vào https://railway.app
2. Đăng nhập/Đăng ký (miễn phí, không cần card)
3. Click "New Project"
4. Chọn "Deploy from GitHub"
5. Authorize GitHub
6. Chọn repo `pdf-refund-splitter`
7. Railway sẽ tự động detect và deploy
8. Chờ ~2 phút, sẽ có URL công khai

**Xong! App sẽ live tại URL như:**
```
https://pdf-refund-splitter-production.up.railway.app
```

---

### Cách 2: Deploy từ Railway CLI

```bash
# 1. Cài Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Tạo project
railway init

# 4. Chọn "Create new project"
# 5. Deploy
railway up

# 6. Link với GitHub (optional)
railway link
```

---

### Cách 3: Deploy Heroku Alternative (Render.com)

**A) Tạo tài khoản Render.com**
1. Vào https://render.com
2. Sign up (free)

**B) Connect GitHub**
1. Click "New+" → "Web Service"
2. Kết nối GitHub
3. Chọn repo
4. Điền thông tin:
   - Name: `pdf-refund-splitter`
   - Runtime: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
5. Click "Create Web Service"

Xong! App sẽ live tại URL Render.

---

## 🔧 Cấu hình

### Environment Variables (nếu cần)
Tạo file `.env`:
```
PORT=3000
NODE_ENV=production
```

### Giới hạn upload
Sửa trong `server.js`:
```javascript
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});
```

---

## 📝 API Endpoints

### POST `/api/process-pdf`
Upload và xử lý PDF

**Request:**
```bash
curl -X POST http://localhost:3000/api/process-pdf \
  -F "pdf=@file.pdf"
```

**Response:**
```json
{
  "success": true,
  "dateStr": "112425",
  "loCount": 5,
  "fileCount": 12,
  "files": ["112425-016.pdf", "112425-019.pdf", ...],
  "downloadUrl": "/download/refund-split-112425.zip"
}
```

### GET `/download/:filename`
Download ZIP file

### GET `/health`
Health check

---

## 🐛 Troubleshooting

### "Cannot find module 'express'"
```bash
npm install
```

### Port already in use
```bash
# Dùng port khác
PORT=3001 npm start
```

### PDF không được process
- Kiểm tra format file PDF
- Đảm bảo có bảng dữ liệu với cột LO

### Railway deployment fail
- Kiểm tra `package.json` có `"start": "node server.js"`
- Logs: `railway logs` (xem chi tiết lỗi)

---

## 📚 Thư viện sử dụng

- **Express.js** - Web framework
- **Multer** - File upload
- **PDF-lib** - PDF processing
- **pdf-parse** - Text extraction
- **Archiver** - ZIP creation

---

## 📧 Support

Nếu gặp lỗi:
1. Kiểm tra logs: `npm run dev` (xem error)
2. Đảm bảo Node.js 18+
3. Cài lại dependencies: `rm -rf node_modules && npm install`

---

## 📄 License

MIT
