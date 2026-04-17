const { Schema } = require("mongoose");

const SupportQuerySchema = new Schema({
    userName: String,
    email: String,
    phone: String,
    category: String,
    subject: String,
    message: String,
    status: {
        type: String,
        default: "Open"
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = { SupportQuerySchema };
