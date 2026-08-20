const bcrypt = require('bcrypt');
const hash = bcrypt.hashSync('123456', 10);
console.log("Copia este hash para tu SQL:");
console.log(hash);