import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './src/routes/authRoutes.js';
import reportRoutes from './src/routes/reportRoutes.js';
import schoolReportRoutes from './src/routes/schoolReportRoutes.js';
import User from './src/models/User.js';
import bcrypt from 'bcryptjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/school-reports', schoolReportRoutes);

app.get('/', (req, res) => {
    res.send('API is running...');
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/daily_perf_monitor')
    .then(async () => {
        console.log('Connected to MongoDB');

        // Seed Default OM User
        try {
            const omEmail = process.env.OM_EMAIL || 'om@company.com';
            const omPassword = process.env.OM_PASSWORD || 'secretOM123';
            const userExists = await User.findOne({ email: omEmail });

            if (!userExists) {
                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(omPassword, salt);
                await User.create({
                    email: omEmail,
                    password: hashedPassword,
                    role: 'OM',
                    isVerified: true
                });
                console.log('Default OM user created.');
            }
        } catch (err) {
            console.error('Error seeding OM user:', err);
        }

        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((error) => console.error('MongoDB connection error:', error));
