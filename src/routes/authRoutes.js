import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect, omOnly } from '../middleware/authMiddleware.js';

const router = express.Router();

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// @desc    Register a new POC User
// @route   POST /api/auth/register
// @access  Public
router.post('/register', async (req, res) => {
    const { email, password } = req.body;

    const userExists = await User.findOne({ email });

    if (userExists) {
        return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate 6 digit code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const user = await User.create({
        email,
        password: hashedPassword,
        role: 'POC',
        isVerified: false,
        verificationCode
    });

    if (user) {
        res.status(201).json({
            _id: user._id,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            message: 'Registration successful. Waiting for OM verification.'
        });
    } else {
        res.status(400).json({ message: 'Invalid user data' });
    }
});

// @desc    Register a new POC-SCHOOL User
// @route   POST /api/auth/register-school
// @access  Public
router.post('/register-school', async (req, res) => {
    const { email, password } = req.body;

    const userExists = await User.findOne({ email });

    if (userExists) {
        return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate 6 digit code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const user = await User.create({
        email,
        password: hashedPassword,
        role: 'POC-SCHOOL',
        isVerified: false,
        verificationCode
    });

    if (user) {
        res.status(201).json({
            _id: user._id,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            message: 'Registration successful. Waiting for OM verification.'
        });
    } else {
        res.status(400).json({ message: 'Invalid user data' });
    }
});

// @desc    Auth user & get token (POCs get a login code instead)
// @route   POST /api/auth/login
// @access  Public
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (user && (await bcrypt.compare(password, user.password))) {
        // OM users log in directly
        if (user.role === 'OM') {
            return res.json({
                _id: user._id,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
                token: generateToken(user._id),
            });
        }

        // POC users - generate a login verification code
        const loginCode = Math.floor(100000 + Math.random() * 900000).toString();
        user.loginCode = loginCode;
        user.loginCodeCreatedAt = new Date();
        user.loginCodeUsed = false;
        await user.save();

        return res.json({
            _id: user._id,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            loginPending: true,
            message: 'Login code generated. Please ask your OM for the code.',
        });
    } else {
        res.status(401).json({ message: 'Invalid email or password' });
    }
});

// @desc    Verify POC login code and return token
// @route   POST /api/auth/verify-login
// @access  Public
router.post('/verify-login', async (req, res) => {
    const { email, code } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    if (!user.loginCode || user.loginCodeUsed) {
        return res.status(400).json({ message: 'No pending login code. Please log in again.' });
    }

    if (user.loginCode === code) {
        user.loginCodeUsed = true;
        await user.save();

        return res.json({
            _id: user._id,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            token: generateToken(user._id),
        });
    } else {
        return res.status(400).json({ message: 'Invalid login code' });
    }
});

// @desc    Get all users (for OM to verify)
// @route   GET /api/auth/users
// @access  Private/OM
router.get('/users', protect, omOnly, async (req, res) => {
    const users = await User.find({ role: { $in: ['POC', 'POC-SCHOOL'] } }).select('-password');
    res.json(users);
});

// @desc    Get pending login codes for OM
// @route   GET /api/auth/login-codes
// @access  Private/OM
router.get('/login-codes', protect, omOnly, async (req, res) => {
    const users = await User.find({
        role: { $in: ['POC', 'POC-SCHOOL'] },
        loginCode: { $ne: null },
    }).select('email loginCode loginCodeCreatedAt loginCodeUsed').sort({ loginCodeCreatedAt: -1 });
    res.json(users);
});

// @desc    Verify POC
// @route   PUT /api/auth/users/:id/verify
// @access  Private/OM
router.put('/users/:id/verify', protect, omOnly, async (req, res) => {
    const user = await User.findById(req.params.id);

    if (user) {
        user.isVerified = true;
        const updatedUser = await user.save();
        res.json({
            _id: updatedUser._id,
            email: updatedUser.email,
            role: updatedUser.role,
            isVerified: updatedUser.isVerified,
        });
    } else {
        res.status(404).json({ message: 'User not found' });
    }
});

// @desc    Verify POC using Code
// @route   POST /api/auth/verify-code
// @access  Public (Since they just registered and may not be logged in fully)
router.post('/verify-code', async (req, res) => {
    const { email, code } = req.body;

    const user = await User.findOne({ email });

    if (user) {
        if (user.isVerified) {
            return res.status(400).json({ message: 'User is already verified' });
        }

        if (user.verificationCode === code) {
            user.isVerified = true;
            user.verificationCode = null;
            const updatedUser = await user.save();

            res.json({
                _id: updatedUser._id,
                email: updatedUser.email,
                role: updatedUser.role,
                isVerified: updatedUser.isVerified,
                token: generateToken(updatedUser._id),
            });
        } else {
            res.status(400).json({ message: 'Invalid verification code' });
        }
    } else {
        res.status(404).json({ message: 'User not found' });
    }
});

export default router;
