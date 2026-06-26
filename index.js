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
const usersCollection = db.collection("user");
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
        const updateData = {};
        if (name) updateData.name = name;
        if (image) updateData.image = image;
        updateData.updatedAt = new Date();

        if (Object.keys(updateData).length === 0) {
            return res.status(400).send({ message: 'No fields to update' });
        }

        const result = await usersCollection.updateOne(
            { email: req.user.email },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ message: 'User not found' });
        }

        // Fetch updated user and remove password
        const updatedUser = await usersCollection.findOne({ email: req.user.email });
        delete updatedUser.password;
        res.send(updatedUser);
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

// ==========================================
// 3. RECIPES APIs
// ==========================================

// GET all recipes with filter, sort, pagination
app.get('/api/recipes', async (req, res) => {
    try {
        const query = {};

        if (req.query.authorEmail) query.authorEmail = req.query.authorEmail;

        // Category filter using $in
        if (req.query.category) {
            const categories = req.query.category.split(',');
            query.category = { $in: categories };
        }

        if (req.query.search) {
            query.$or = [
                { recipeName: { $regex: req.query.search, $options: 'i' } },
                { ingredients: { $regex: req.query.search, $options: 'i' } }
            ];
        }

        // Public view: only show visible recipes
        if (!req.query.authorEmail && !req.query.admin) {
            query.isHidden = { $ne: true };
        }

        let sortObj = { createdAt: -1 };
        if (req.query.sort === 'popular') sortObj = { likesCount: -1 };
        if (req.query.sort === 'oldest') sortObj = { createdAt: 1 };

        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 9;
        const skip = (page - 1) * perPage;

        const total = await recipesCollection.countDocuments(query);
        const recipes = await recipesCollection.find(query).sort(sortObj).skip(skip).limit(perPage).toArray();

        res.send({ total, recipes });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET featured recipes (for homepage)
app.get('/api/recipes/featured', async (req, res) => {
    try {
        const recipes = await recipesCollection
            .find({ isFeatured: true, isHidden: { $ne: true } })
            .toArray();
        res.send(recipes);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET popular recipes (most liked, for homepage)
app.get('/api/recipes/popular', async (req, res) => {
    try {
        const recipes = await recipesCollection
            .find({ isHidden: { $ne: true } })
            .sort({ likesCount: -1 })
            .limit(6)
            .toArray();
        res.send(recipes);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET single recipe
app.get('/api/recipes/:id', async (req, res) => {
    try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });
        res.send(recipe);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// POST add new recipe
app.post('/api/recipes', verifyToken, async (req, res) => {
    try {
        const user = req.user;

        // Check recipe limit for non-premium users
        if (!user.isPremium) {
            const count = await recipesCollection.countDocuments({ authorEmail: user.email });
            if (count >= 2) {
                return res.status(403).send({
                    message: 'Free users can only add 2 recipes. Upgrade to premium for unlimited recipes.'
                });
            }
        }

        const recipeData = req.body;
        const newRecipe = {
            ...recipeData,
            authorId: user._id.toString(),
            authorName: user.name,
            authorEmail: user.email,
            likesCount: 0,
            likedBy: [],
            isFeatured: false,
            isHidden: false,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await recipesCollection.insertOne(newRecipe);
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH update recipe
app.patch('/api/recipes/:id', verifyToken, async (req, res) => {
    try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        if (recipe.authorEmail !== req.user.email && req.user.role !== 'admin') {
            return res.status(403).send({ message: 'Unauthorized' });
        }

        const result = await recipesCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { ...req.body, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// DELETE recipe
app.delete('/api/recipes/:id', verifyToken, async (req, res) => {
    try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        if (recipe.authorEmail !== req.user.email && req.user.role !== 'admin') {
            return res.status(403).send({ message: 'Unauthorized' });
        }

        const result = await recipesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH toggle like on recipe
app.patch('/api/recipes/:id/like', verifyToken, async (req, res) => {
    try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        const userEmail = req.user.email;
        const likedBy = recipe.likedBy || [];
        const alreadyLiked = likedBy.includes(userEmail);

        const update = alreadyLiked
            ? { $pull: { likedBy: userEmail }, $inc: { likesCount: -1 } }
            : { $push: { likedBy: userEmail }, $inc: { likesCount: 1 } };

        await recipesCollection.updateOne({ _id: new ObjectId(req.params.id) }, update);

        const updated = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        res.send({ liked: !alreadyLiked, likesCount: updated.likesCount });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// 4. FAVORITES APIs
// ==========================================

// POST add to favorites
app.post('/api/favorites', verifyToken, async (req, res) => {
    try {
        const { recipeId } = req.body;
        const userEmail = req.user.email;

        const exists = await favoritesCollection.findOne({ recipeId, userEmail });
        if (exists) return res.status(400).send({ message: 'Already in favorites' });

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        const result = await favoritesCollection.insertOne({
            recipeId,
            userEmail,
            userId: req.user._id.toString(),
            addedAt: new Date()
        });
        res.send({ success: true, id: result.insertedId });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET user favorites
app.get('/api/favorites', verifyToken, async (req, res) => {
    try {
        const favorites = await favoritesCollection
            .find({ userEmail: req.user.email })
            .sort({ addedAt: -1 })
            .toArray();

        // Populate recipe details
        const populated = await Promise.all(favorites.map(async (fav) => {
            const recipe = await recipesCollection.findOne({ _id: new ObjectId(fav.recipeId) });
            return { ...fav, recipe };
        }));

        res.send(populated);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// DELETE remove from favorites
app.delete('/api/favorites/:recipeId', verifyToken, async (req, res) => {
    try {
        const result = await favoritesCollection.deleteOne({
            recipeId: req.params.recipeId,
            userEmail: req.user.email
        });
        if (result.deletedCount === 0) return res.status(404).send({ message: 'Favorite not found' });
        res.send({ success: true });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// 5. REPORTS APIs
// ==========================================

// POST create report
app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { recipeId, reason } = req.body;
        const reporterEmail = req.user.email;

        const existing = await reportsCollection.findOne({
            recipeId,
            reporterEmail,
            status: 'pending'
        });
        if (existing) return res.status(400).send({ message: 'You already reported this recipe' });

        const result = await reportsCollection.insertOne({
            recipeId,
            reporterEmail,
            reason,
            status: 'pending',
            createdAt: new Date()
        });
        res.send({ success: true, id: result.insertedId });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET all reports (admin)
app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        if (req.query.status) query.status = req.query.status;

        const reports = await reportsCollection.find(query).sort({ createdAt: -1 }).toArray();

        // Populate recipe info
        const populated = await Promise.all(reports.map(async (report) => {
            try {
                const recipe = await recipesCollection.findOne({ _id: new ObjectId(report.recipeId) });
                return { ...report, recipe };
            } catch {
                return { ...report, recipe: null };
            }
        }));

        res.send(populated);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH dismiss report
app.patch('/api/reports/:id/dismiss', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await reportsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'dismissed', updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// DELETE recipe from report (admin removes the recipe)
app.delete('/api/reports/:id/remove-recipe', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const report = await reportsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!report) return res.status(404).send({ message: 'Report not found' });

        await recipesCollection.deleteOne({ _id: new ObjectId(report.recipeId) });
        await reportsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'resolved', updatedAt: new Date() } }
        );

        res.send({ success: true, message: 'Recipe removed and report resolved' });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// 6. PAYMENT APIs (Stripe)
// ==========================================

// POST create checkout for premium membership
app.post('/api/payments/premium-checkout', verifyToken, async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'RecipeHub Premium Membership' },
                    unit_amount: 999, // $9.99
                },
                quantity: 1,
            }],
            metadata: {
                userEmail: req.user.email,
                userId: req.user._id.toString(),
                type: 'premium'
            },
            success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/dashboard`,
        });

        res.send({ url: session.url });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// POST create checkout for recipe purchase
app.post('/api/payments/recipe-checkout', verifyToken, async (req, res) => {
    try {
        const { recipeId } = req.body;

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        // Check if already purchased
        const alreadyPurchased = await purchasesCollection.findOne({
            recipeId,
            userEmail: req.user.email
        });
        if (alreadyPurchased) return res.status(400).send({ message: 'Already purchased' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: recipe.recipeName },
                    unit_amount: (recipe.price || 199), // default $1.99
                },
                quantity: 1,
            }],
            metadata: {
                userEmail: req.user.email,
                userId: req.user._id.toString(),
                recipeId,
                type: 'recipe'
            },
            success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/recipes/${recipeId}`,
        });

        res.send({ url: session.url });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// POST stripe webhook
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send({ message: `Webhook Error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { userEmail, userId, recipeId, type } = session.metadata;

        // Save payment record
        await paymentsCollection.insertOne({
            userEmail,
            userId,
            recipeId: recipeId || null,
            amount: session.amount_total / 100,
            transactionId: session.payment_intent,
            paymentStatus: 'completed',
            type,
            paidAt: new Date(),
            createdAt: new Date()
        });

        if (type === 'premium') {
            // Upgrade user to premium
            await usersCollection.updateOne(
                { email: userEmail },
                { $set: { isPremium: true, updatedAt: new Date() } }
            );
        }

        if (type === 'recipe' && recipeId) {
            // Save to purchases
            await purchasesCollection.insertOne({
                userEmail,
                userId,
                recipeId,
                transactionId: session.payment_intent,
                purchasedAt: new Date()
            });
        }
    }

    res.send({ received: true });
});

// GET verify payment session (after redirect)
app.get('/api/payments/verify/:sessionId', verifyToken, async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
        if (session.payment_status === 'paid') {
            res.send({ success: true, metadata: session.metadata });
        } else {
            res.send({ success: false });
        }
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET user purchased recipes
app.get('/api/purchases', verifyToken, async (req, res) => {
    try {
        const purchases = await purchasesCollection
            .find({ userEmail: req.user.email })
            .sort({ purchasedAt: -1 })
            .toArray();

        const populated = await Promise.all(purchases.map(async (p) => {
            try {
                const recipe = await recipesCollection.findOne({ _id: new ObjectId(p.recipeId) });
                return { ...p, recipe };
            } catch {
                return { ...p, recipe: null };
            }
        }));

        res.send(populated);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET all transactions (admin)
app.get('/api/payments', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const payments = await paymentsCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.send(payments);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// 7. ADMIN APIs
// ==========================================

// GET admin dashboard stats
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const [totalUsers, totalRecipes, totalPremium, totalReports] = await Promise.all([
            usersCollection.countDocuments(),
            recipesCollection.countDocuments(),
            usersCollection.countDocuments({ isPremium: true }),
            reportsCollection.countDocuments({ status: 'pending' })
        ]);

        res.send({ totalUsers, totalRecipes, totalPremium, totalReports });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET all users (admin)
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        if (req.query.search) {
            query.$or = [
                { name: { $regex: req.query.search, $options: 'i' } },
                { email: { $regex: req.query.search, $options: 'i' } }
            ];
        }
        const users = await usersCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(users);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH block/unblock user (admin)
app.patch('/api/admin/users/:id/block', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { isBlocked } = req.body;
        const result = await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { isBlocked, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// GET all recipes (admin)
app.get('/api/admin/recipes', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        const total = await recipesCollection.countDocuments();
        const recipes = await recipesCollection.find({}).sort({ createdAt: -1 }).skip(skip).limit(perPage).toArray();

        res.send({ total, recipes });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH feature/unfeature recipe (admin)
app.patch('/api/admin/recipes/:id/feature', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { isFeatured } = req.body;
        const result = await recipesCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { isFeatured, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// DELETE recipe (admin)
app.delete('/api/admin/recipes/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await recipesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// PATCH edit recipe (admin)
app.patch('/api/admin/recipes/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await recipesCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { ...req.body, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// Start Server
// ==========================================

app.listen(port, () => {
    console.log(`RecipeHub backend running on port ${port}`);
});

module.exports = app;