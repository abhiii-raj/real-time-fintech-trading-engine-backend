const { Schema } = require("mongoose");

const UserSchema = new Schema({
    fullName: String,
    profileImage: {
        type: String,
        default: ""
    },
    email: {
        type: String,
        unique: true,
        required: true
    },
    username: {
        type: String,
        unique: true,
        required: true
    },
    passwordHash: {
        type: String,
        default: ""
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    emailVerificationCode: {
        type: String,
        default: ""
    },
    emailVerificationExpiresAt: {
        type: Date,
        default: null
    },
    oauthProvider: {
        type: String,
        default: ""
    },
    oauthId: {
        type: String,
        default: ""
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = { UserSchema };