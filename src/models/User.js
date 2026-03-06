import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ['OM', 'POC', 'POC-SCHOOL'],
    default: 'POC',
  },
  isVerified: {
    type: Boolean,
    default: false, // OMs are verified by default, POCs need verification
  },
  verificationCode: {
    type: String,
    default: null,
  },
  loginCode: {
    type: String,
    default: null,
  },
  loginCodeCreatedAt: {
    type: Date,
    default: null,
  },
  loginCodeUsed: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

export default mongoose.model('User', userSchema);
