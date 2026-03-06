import mongoose from 'mongoose';

const reportSchema = new mongoose.Schema({
    account: { type: String, required: true },
    endorsementDate: { type: Date },
    packageType: { type: String },
    isCompleted: { type: Boolean, default: false },
    status: { type: String, enum: ['Completed', 'Pending'], default: 'Pending' },
    completionDate: { type: Date },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checks: {
        type: Map,
        of: String
    }
}, { timestamps: true });

export default mongoose.model('Report', reportSchema);
