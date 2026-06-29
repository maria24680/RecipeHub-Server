const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8000;

// ─── CONDITIONAL STRIPE INITIALIZATION ───────────────────────
let stripe = null;
try {
    if (process.env.STRIPE_SECRET_KEY) {
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        console.log('✅ Stripe initialized successfully');
    } else {
        console.log('⚠️ STRIPE_SECRET_KEY not found – Stripe features disabled');
    }
} catch (err) {
    console.error('❌ Failed to initialize Stripe:', err.message);
}



// ─── Webhook route (must be BEFORE express.json()) ──────────
if (stripe) {
    app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
            console.log('Webhook event:', event.type);
        } catch (err) {
            console.error('Webhook signature verification failed:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const { userEmail, userId, recipeId, type } = session.metadata;

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
                await usersCollection.updateOne(
                    { email: userEmail },
                    { $set: { isPremium: true, updatedAt: new Date() } }
                );
                console.log(`User ${userEmail} upgraded to premium`);
            }

            if (type === 'recipe' && recipeId) {
                await purchasesCollection.insertOne({
                    userEmail,
                    userId,
                    recipeId,
                    transactionId: session.payment_intent,
                    purchasedAt: new Date()
                });
                console.log(`Recipe ${recipeId} purchased by ${userEmail}`);
            }
        }

        res.send({ received: true });
    });
}





// ─── Regular middleware ──────────────────────────────────────
app.use(cors({
    /* origin: process.env.CLIENT_URL || 'http://localhost:3000',
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
    .then(() => console.log('✅ Successfully connected to MongoDB!'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

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

    if (!authHeader && !userEmail) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }

    try {
        let user;

        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (!token) return res.status(401).send({ message: 'Unauthorized access' });

            const session = await sessionsCollection.findOne({ token });
            if (!session) return res.status(401).send({ message: 'Invalid or expired session' });

            user = await usersCollection.findOne({ email: session.userEmail || session.userId });
        } else {
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

app.get('/api/users/me', verifyToken, async (req, res) => {
    try {
        res.send(req.user);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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

        const updatedUser = await usersCollection.findOne({ email: req.user.email });
        delete updatedUser.password;
        res.send(updatedUser);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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

app.get('/api/recipes', async (req, res) => {
    try {
        const query = {};

        if (req.query.authorEmail) query.authorEmail = req.query.authorEmail;

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

        // ─── Public view: only approved & not hidden ───
        if (!req.query.authorEmail && !req.query.admin) {
            query.isHidden = { $ne: true };
            query.status = 'approved';
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

app.get('/api/recipes/:id', async (req, res) => {
    try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });
        res.send(recipe);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

app.post('/api/recipes', verifyToken, async (req, res) => {
    try {
        const user = req.user;

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

app.get('/api/favorites', verifyToken, async (req, res) => {
    try {
        const favorites = await favoritesCollection
            .find({ userEmail: req.user.email })
            .sort({ addedAt: -1 })
            .toArray();

        const populated = await Promise.all(favorites.map(async (fav) => {
            const recipe = await recipesCollection.findOne({ _id: new ObjectId(fav.recipeId) });
            return { ...fav, recipe };
        }));

        res.send(populated);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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

app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        if (req.query.status && req.query.status !== 'all') {
            query.status = req.query.status;
        }

        const total = await reportsCollection.countDocuments(query);
        const reports = await reportsCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(perPage).toArray();

        const populated = await Promise.all(reports.map(async (report) => {
            try {
                const recipe = await recipesCollection.findOne({ _id: new ObjectId(report.recipeId) });
                return { ...report, recipe };
            } catch {
                return { ...report, recipe: null };
            }
        }));

        res.send({ total, reports: populated });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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
// 6. PAYMENT APIs (Stripe - conditional)
// ==========================================

// ─── Premium membership checkout (BDT) ──────────────────────
app.post('/api/payments/premium-checkout', verifyToken, async (req, res) => {
    if (!stripe) {
        return res.status(503).send({ error: 'Stripe is not configured' });
    }
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'bdt',
                    product_data: { name: 'RecipeHub Premium Membership' },
                    description: 'Unlimited recipe uploads and premium badge',
                },
                unit_amount: 99900,
                quantity: 1,
            }],
            metadata: {
                userEmail: req.user.email,
                userId: req.user._id.toString(),
                type: 'premium',
                amount: '999.00'
            },
            success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/dashboard`,
        });

        res.send({ url: session.url });
    } catch (err) {
        console.error('Premium checkout error:', err);
        res.status(500).send({ message: err.message });
    }
});

// ─── Recipe purchase checkout (BDT) ────────────────────────
app.post('/api/payments/recipe-checkout', verifyToken, async (req, res) => {
    if (!stripe) {
        return res.status(503).send({ error: 'Stripe is not configured' });
    }
    try {
        const { recipeId } = req.body;

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        const alreadyPurchased = await purchasesCollection.findOne({
            recipeId,
            userEmail: req.user.email
        });
        if (alreadyPurchased) return res.status(400).send({ message: 'Already purchased' });

        const priceInBDT = recipe.price || 499;
        const unitAmount = Math.round(priceInBDT * 100);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'bdt',
                    product_data: { name: recipe.recipeName },
                    description: `Premium recipe: ${recipe.recipeName}`,
                },
                unit_amount: unitAmount,
                quantity: 1,
            }],
            metadata: {
                userEmail: req.user.email,
                userId: req.user._id.toString(),
                recipeId: recipeId,
                type: 'recipe',
                amount: priceInBDT.toString(),
            },
            success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/recipes/${recipeId}`,
        });

        res.send({ url: session.url });
    } catch (err) {
        console.error('Recipe checkout error:', err);
        res.status(500).send({ message: err.message });
    }
});

// ─── Verify payment session ──────────────────────────────────
app.get('/api/payments/verify/:sessionId', verifyToken, async (req, res) => {
    if (!stripe) {
        return res.status(503).send({ error: 'Stripe is not configured' });
    }
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

app.post('/api/payments/confirm-purchase', verifyToken, async (req, res) => {
    if (!stripe) {
        return res.status(503).send({ error: 'Stripe is not configured' });
    }
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).send({ message: 'Session ID is required' });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return res.status(400).send({ message: 'Payment not completed' });
        }

        const { userEmail, userId, recipeId, type } = session.metadata;

        if (userEmail !== req.user.email) {
            return res.status(403).send({ message: 'Unauthorized' });
        }

        // Check duplicate purchase
        if (type === 'recipe' && recipeId) {
            const existing = await purchasesCollection.findOne({
                recipeId,
                userEmail: req.user.email
            });
            if (existing) {
                return res.status(400).send({ message: 'Already purchased' });
            }
        }

        // Save payment record
        await paymentsCollection.insertOne({
            userEmail,
            userId: userId || req.user._id.toString(),
            recipeId: recipeId || null,
            amount: session.amount_total / 100,
            transactionId: session.payment_intent,
            paymentStatus: 'completed',
            type: type || 'recipe',
            paidAt: new Date(),
            createdAt: new Date()
        });

        if (type === 'premium') {
            await usersCollection.updateOne(
                { email: userEmail },
                { $set: { isPremium: true, updatedAt: new Date() } }
            );
        }

        if (type === 'recipe' && recipeId) {
            await purchasesCollection.insertOne({
                userEmail,
                userId: userId || req.user._id.toString(),
                recipeId,
                transactionId: session.payment_intent,
                purchasedAt: new Date()
            });
        }

        res.send({ success: true, message: 'Purchase confirmed' });
    } catch (err) {
        console.error('Confirm purchase error:', err);
        res.status(500).send({ message: err.message });
    }
});

// ─── Get user purchased recipes ──────────────────────────────
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

// ─── Get all payments (admin) ──────────────────────────────────
app.get('/api/payments', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const payments = await paymentsCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.send(payments);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ─── TEST: Add a purchase directly (skip Stripe) ──────────────
app.post('/api/purchases/test', verifyToken, async (req, res) => {
    try {
        const { recipeId } = req.body;
        const userEmail = req.user.email;

        const existing = await purchasesCollection.findOne({ recipeId, userEmail });
        if (existing) {
            return res.status(400).send({ message: 'Already purchased' });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(recipeId) });
        if (!recipe) return res.status(404).send({ message: 'Recipe not found' });

        const result = await purchasesCollection.insertOne({
            userEmail,
            userId: req.user._id.toString(),
            recipeId,
            transactionId: 'test_' + new ObjectId().toString(),
            purchasedAt: new Date()
        });

        res.send({ success: true, message: 'Purchase recorded (test mode)' });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// 7. ADMIN APIs
// ==========================================

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

app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        if (req.query.search) {
            query.$or = [
                { name: { $regex: req.query.search, $options: 'i' } },
                { email: { $regex: req.query.search, $options: 'i' } }
            ];
        }
        if (req.query.role) {
            query.role = req.query.role;
        }

        const total = await usersCollection.countDocuments(query);
        const users = await usersCollection
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(perPage)
            .toArray();

        const sanitizedUsers = users.map(user => {
            const { password, ...rest } = user;
            return rest;
        });

        res.send({ total, users: sanitizedUsers });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

app.patch('/api/admin/users/:id/block', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { isBlocked } = req.body;
        const userId = req.params.id;
        const adminUser = req.user;

        if (adminUser._id.toString() === userId) {
            return res.status(400).send({ message: 'You cannot block yourself' });
        }

        const targetUser = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!targetUser) return res.status(404).send({ message: 'User not found' });

        if (targetUser.role === 'admin') {
            return res.status(400).send({ message: 'Cannot block another admin' });
        }

        const result = await usersCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: { isBlocked, updatedAt: new Date() } }
        );

        res.send({ success: true, message: `User ${isBlocked ? 'blocked' : 'unblocked'}` });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

app.get('/api/admin/recipes', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        if (req.query.search) {
            query.$or = [
                { recipeName: { $regex: req.query.search, $options: 'i' } },
                { authorName: { $regex: req.query.search, $options: 'i' } }
            ];
        }
        if (req.query.status && req.query.status !== 'all') {
            query.status = req.query.status;
        }

        const total = await recipesCollection.countDocuments(query);
        const recipes = await recipesCollection
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(perPage)
            .toArray();

        res.send({ total, recipes });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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

app.delete('/api/admin/recipes/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await recipesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

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

app.patch('/api/admin/recipes/:id/verify', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { status, isHidden } = req.body;
        const id = req.params.id;
        const updateDoc = { updatedAt: new Date() };

        if (status) {
            const valid = ['pending', 'approved', 'rejected'];
            if (!valid.includes(status)) {
                return res.status(400).send({ message: 'Invalid status' });
            }
            updateDoc.status = status;
        }
        if (typeof isHidden === 'boolean') {
            updateDoc.isHidden = isHidden;
        }

        const result = await recipesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateDoc }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ message: 'Recipe not found' });
        }

        res.send({ success: true, message: 'Recipe updated' });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

app.patch('/api/admin/recipes/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const id = req.params.id;

        const validStatuses = ['pending', 'approved', 'rejected'];
        if (!validStatuses.includes(status)) {
            return res.status(400).send({ message: 'Invalid status' });
        }

        const result = await recipesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send({ message: 'Recipe not found' });
        }

        res.send({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// ==========================================
// Start Server
// ==========================================

app.listen(port, () => {
    console.log(`🍳 RecipeHub backend running on port ${port}`);
});

module.exports = app;