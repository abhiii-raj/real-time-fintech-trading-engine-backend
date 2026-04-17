const { model } = require("mongoose");

const { SupportQuerySchema } = require("../schemas/SupportQuerySchema");

const SupportQueryModel = new model("supportquery", SupportQuerySchema);

module.exports = { SupportQueryModel };
