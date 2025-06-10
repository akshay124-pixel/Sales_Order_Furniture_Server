const User = require("../Models/Model");
const bcrypt = require("bcrypt");
const { generateToken } = require("../utils/config jwt");

// Valid roles from User schema
const VALID_ROLES = [
  "Production",
  "Sales",
  "Installation",
  "Finish",
  "Accounts",
  "Admin",
  "Verification",
  "Bill",
  "ProductionApproval",
];

// Signup Controller
const Signup = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        message: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
      });
    }

    const existingEmailUser = await User.findOne({ email });
    if (existingEmailUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      role,
    });

    await newUser.save();

    const token = generateToken(newUser);

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: newUser._id.toString(),
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
      },
      token,
    });
  } catch (error) {
    console.error("Signup Error:", error);
    return res.status(500).json({
      message: "An error occurred during signup",
      error: error.message,
    });
  }
};

// Login Controller
const Login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.error("User not found:", email);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.error("Incorrect password for user:", email);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(user);

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({
      message: "An error occurred during login",
      error: error.message,
    });
  }
};

module.exports = { Signup, Login };
