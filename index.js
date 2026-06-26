const express = require('express');
const cors = require('cors');
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors({
    /* origin: [process.env.BETTER_AUTH_URL],
    credentials: true */
}));
app.use(express.json());

// Root Route
app.get('/', (req, res) => {
    res.send('Welcome to RecipeHub Server!');
});

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

client.connect()
    .then(() => console.log('Successfully connected to MongoDB!'))
    .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Collections
const db = client.db("recipehub");
const usersCollection = db.collection("users");
const recipesCollection = db.collection("recipes");
const favoritesCollection = db.collection("favorites");
const reportsCollection = db.collection("reports");
const paymentsCollection = db.collection("payments");
const purchasesCollection = db.collection("purchases");
const sessionsCollection = db.collection("session");

// ==========================================
// MIDDLEWARES
// ==========================================

// Session-based auth middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers?.authorization;
    const userEmail = req.headers?.['user-email'];

    // Support both Bearer token and user-email header
    if (!authHeader && !userEmail) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }

    try {
        let user;

        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (!token) return res.status(401).send({ message: 'Unauthorized access' });

            // Check better-auth session collection
            const session = await sessionsCollection.findOne({ token });
            if (!session) return res.status(401).send({ message: 'Invalid or expired session' });

            user = await usersCollection.findOne({ email: session.userEmail || session.userId });
        } else {
            // Fallback: email header (synced user)
            user = await usersCollection.findOne({ email: userEmail });
        }

        if (!user) return res.status(401).send({ message: 'User not found' });
        if (user.isBlocked) return res.status(403).send({ message: 'Your account has been blocked' });

        req.user = user;
        next();
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
};

const verifyAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden. Admins only.' });
    }
    next();
};

// ==========================================
// 1. AUTH / SESSION APIs
// ==========================================

// Sync user on login/register & create session
app.post('/api/auth/sync', async (req, res) => {
    try {
        const { email, name, image } = req.body;
        if (!email) return res.status(400).send({ message: 'Email is required' });

        let user = await usersCollection.findOne({ email });

        if (!user) {
            const newUser = {
                email,
                name,
                image: image || 'https://placehold.co/100',
                role: 'user',
                isBlocked: false,
                isPremium: false,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            const result = await usersCollection.insertOne(newUser);
            user = await usersCollection.findOne({ _id: result.insertedId });
        }

        // Create session token
        const token = new ObjectId().toString() + new ObjectId().toString();
        await sessionsCollection.insertOne({
            token,
            email: user.email,
            createdAt: new Date()
        });

        res.send({ token, user });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// Logout - delete session
app.post('/api/auth/logout', async (req, res) => {
    try {
        const authHeader = req.headers?.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            await sessionsCollection.deleteOne({ token });
        }
        res.send({ message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});
// ==========================================
// 2. USER APIs
// ==========================================

// GET current user
app.get('/api/users/me', verifyToken, async (req, res) => {
    try {
        res.send(req.user);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH update user profile (name & image)
app.patch('/api/users/me', verifyToken, async (req, res) => {
    try {
        const { name, image } = req.body;
        const result = await usersCollection.updateOne(
            { email: req.user.email },
            { $set: { name, image, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET user dashboard overview stats
app.get('/api/users/me/stats', verifyToken, async (req, res) => {
    try {
        const email = req.user.email;

        const totalRecipes = await recipesCollection.countDocuments({ authorEmail: email });
        const totalFavorites = await favoritesCollection.countDocuments({ userEmail: email });

        const userRecipes = await recipesCollection.find({ authorEmail: email }).toArray();
        const totalLikesReceived = userRecipes.reduce((sum, r) => sum + (r.likesCount || 0), 0);

        res.send({
            totalRecipes,
            totalFavorites,
            totalLikesReceived,
            isPremium: req.user.isPremium || false
        });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});