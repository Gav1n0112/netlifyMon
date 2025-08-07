const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const serverless = require('serverless-http');
const { MongoClient } = require('mongodb');

const app = express();
const router = express.Router();
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use('/.netlify/functions/server', router);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';
const MONGODB_URI = process.env.MONGODB_URI;
const client = new MongoClient(MONGODB_URI);

async function getCollections() {
  try {
    if (!client.topology || !client.topology.isConnected()) {
      await client.connect();
    }
    const db = client.db();
    return {
      software: db.collection('software'),
      keys: db.collection('keys'),
      user: db.collection('user')
    };
  } catch (error) {
    console.error('MongoDB连接失败:', error.message);
    throw new Error('数据库连接失败');
  }
}

async function initAdmin() {
  const { user } = await getCollections();
  const existingUser = await user.findOne({});
  if (!existingUser) {
    await user.insertOne({
      username: 'admin',
      password: hashPassword('password'),
      updatedAt: new Date().toISOString()
    });
    console.log('初始化管理员账号成功');
  }
}
initAdmin().catch(err => console.error('初始化管理员失败:', err));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, hashedPassword) {
  const [salt, hash] = hashedPassword.split(':');
  const newHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return newHash === hash;
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}

function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: '未提供令牌' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(403).json({ message: '令牌无效或已过期' });
      req.user = user;
      next();
    });
  } catch (error) {
    res.status(500).json({ message: '权限验证失败' });
  }
}

function generateFormattedKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 4; i++) key += chars[Math.floor(Math.random() * chars.length)];
  key += '-';
  for (let i = 0; i < 4; i++) key += chars[Math.floor(Math.random() * chars.length)];
  key += '-';
  for (let i = 0; i < 4; i++) key += chars[Math.floor(Math.random() * chars.length)];
  key += '-';
  for (let i = 0; i < 4; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

router.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: '请提供用户名和密码' });

    const { user } = await getCollections();
    const admin = await user.findOne({ username });
    if (!admin || !verifyPassword(password, admin.password)) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }

    res.json({ token: generateToken(admin.username) });
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.post('/api/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: '请提供当前密码和新密码' });

    const { user } = await getCollections();
    const admin = await user.findOne({});
    if (!verifyPassword(currentPassword, admin.password)) {
      return res.status(401).json({ message: '当前密码错误' });
    }

    await user.updateOne({}, { 
      $set: { 
        password: hashPassword(newPassword),
        updatedAt: new Date().toISOString()
      } 
    });
    res.json({ message: '密码修改成功' });
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.get('/api/software', authenticateToken, async (req, res) => {
  try {
    const { software } = await getCollections();
    const list = await software.find({}).toArray();
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: '获取软件列表失败' });
  }
});

router.post('/api/software', authenticateToken, async (req, res) => {
  try {
    const { name, fileType, downloadUrls } = req.body;
    if (!name || !fileType || !downloadUrls?.length) {
      return res.status(400).json({ message: '请填写软件名称、类型和至少一个下载地址' });
    }

    const newSoftware = {
      id: uuidv4(),
      name,
      fileType,
      downloadUrls,
      createdAt: new Date().toISOString()
    };

    const { software } = await getCollections();
    await software.insertOne(newSoftware);
    res.json(newSoftware);
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.put('/api/software/:id', authenticateToken, async (req, res) => {
  try {
    const { name, fileType, downloadUrls } = req.body;
    const softwareId = req.params.id;
    if (!name || !fileType || !downloadUrls?.length) {
      return res.status(400).json({ message: '请填写软件名称、类型和至少一个下载地址' });
    }

    const { software } = await getCollections();
    const updated = await software.findOneAndUpdate(
      { id: softwareId },
      { $set: { name, fileType, downloadUrls, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' }
    );

    if (!updated) return res.status(404).json({ message: '软件不存在' });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.delete('/api/software/:id', authenticateToken, async (req, res) => {
  try {
    const softwareId = req.params.id;
    const { software, keys } = await getCollections();

    const deletedSoftware = await software.deleteOne({ id: softwareId });
    if (deletedSoftware.deletedCount === 0) {
      return res.status(404).json({ message: '软件不存在' });
    }

    await keys.deleteMany({ softwareId });
    res.json({ message: '软件删除成功' });
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.get('/api/keys', authenticateToken, async (req, res) => {
  try {
    const { keys, software } = await getCollections();
    const keysList = await keys.find({}).toArray();
    const softwareList = await software.find({}).toArray();

    // 关键修改：统一使用firstUsedAt判断是否已使用
    const keysWithSoftware = keysList.map(key => ({
      ...key,
      software: softwareList.find(s => s.id === key.softwareId),
      used: !!key.firstUsedAt // 前端通过该字段显示状态
    }));

    res.json(keysWithSoftware);
  } catch (error) {
    res.status(500).json({ message: '获取卡密列表失败' });
  }
});

router.post('/api/keys', authenticateToken, async (req, res) => {
  try {
    const { softwareId, count, validityDays } = req.body;
    if (!softwareId || !count || count <= 0 || count > 100) {
      return res.status(400).json({ message: '请选择软件并输入有效的卡密数量（1-100）' });
    }

    const { software, keys } = await getCollections();
    const softwareExists = await software.findOne({ id: softwareId });
    if (!softwareExists) {
      return res.status(404).json({ message: '软件不存在' });
    }

    const newKeys = [];
    for (let i = 0; i < count; i++) {
      const keyCode = generateFormattedKey();
      const newKey = {
        id: uuidv4(),
        code: keyCode,
        softwareId,
        firstUsedAt: null, // 初始化为未使用
        createdAt: new Date().toISOString(),
        validUntil: validityDays ? new Date(Date.now() + validityDays * 86400000).toISOString() : null
      };
      newKeys.push(newKey);
    }

    await keys.insertMany(newKeys);
    res.json({ keys: newKeys });
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

router.delete('/api/keys/:id', authenticateToken, async (req, res) => {
  try {
    const keyId = req.params.id;
    const { keys } = await getCollections();
    const result = await keys.deleteOne({ id: keyId });

    if (result.deletedCount === 0) return res.status(404).json({ message: '卡密不存在' });
    res.json({ message: '卡密删除成功' });
  } catch (error) {
    res.status(500).json({ message: '服务器错误' });
  }
});

// 验证卡密接口（核心修改：确保首次使用后标记状态）
router.post('/api/verify-key', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: '请提供卡密' });

    const { keys, software } = await getCollections();
    const key = await keys.findOne({ code: code.trim() });

    if (!key) return res.status(404).json({ message: '卡密不存在', valid: false });
    
    // 检查过期（不修改有效期）
    if (key.validUntil && new Date(key.validUntil) < new Date()) {
      return res.json({ message: '卡密已过期', valid: false, expired: true });
    }

    // 首次使用时更新状态（关键逻辑）
    if (!key.firstUsedAt) {
      await keys.updateOne(
        { id: key.id },
        { $set: { firstUsedAt: new Date().toISOString() } } // 仅记录使用时间
      );
    }

    const softwareInfo = await software.findOne({ id: key.softwareId });
    res.json({ 
      valid: true, 
      message: key.firstUsedAt ? '卡密有效' : '首次使用验证成功',
      software: softwareInfo,
      validUntil: key.validUntil, // 保留原始有效期
      firstUsedAt: key.firstUsedAt || new Date().toISOString()
    });
  } catch (error) {
    console.error('卡密验证错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

module.exports.handler = serverless(app);
