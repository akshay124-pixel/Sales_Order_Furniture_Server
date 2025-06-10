const mongoose = require("mongoose");

const URI =
  "mongodb+srv://promarkdatabase:promarkdatabase%401234@promarkdb.zfwjisc.mongodb.net/So_Mangement_Furniture";
const dbconnect = async () => {
  try {
    await mongoose.connect(URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Database connected");
  } catch (error) {
    console.error("Error connecting to database:", error.message);
  }
};

module.exports = dbconnect;
