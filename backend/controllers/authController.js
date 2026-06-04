const bcrypt = require("bcryptjs");
const db = require("../config/db");
const generateToken = require("../utils/generateToken");

// REGISTER
exports.register = (req, res) => {
  const { fullname, email, password, role } = req.body || {};

  if (!fullname || !email || !password) {
    return res.status(400).json({
      message: "Missing required fields"
    });
  }

  res.json({ message: "OK" });
};

// LOGIN
exports.login = (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE email=?",
    [email],
    (err, result) => {
      if (err) return res.status(500).json(err);

      if (result.length === 0)
        return res.status(401).json({ message: "Invalid" });

      const user = result[0];

      const match = bcrypt.compareSync(password, user.password_hash);

      if (!match)
        return res.status(401).json({ message: "Invalid" });

      const token = generateToken(user);

      res.json({
        token,
        user
      });
    }
  );
};