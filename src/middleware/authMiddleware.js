import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            req.user = await User.findById(decoded.id).select('-password');
            if (!req.user) {
                return res.status(401).json({ message: 'User not found' });
            }
            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

export const omOnly = (req, res, next) => {
    if (req.user && req.user.role === 'OM') {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as an OM' });
    }
};

export const tlOnly = (req, res, next) => {
    if (req.user && req.user.role === 'TL') {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as a TL' });
    }
};

export const tlSchoolOnly = (req, res, next) => {
    if (req.user && req.user.role === 'TL-SCHOOL') {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as a School TL' });
    }
};

export const tlOrOm = (req, res, next) => {
    if (req.user && (req.user.role === 'TL' || req.user.role === 'TL-SCHOOL' || req.user.role === 'OM')) {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized' });
    }
};
