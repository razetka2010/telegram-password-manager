class Database {
    private $host = "dpg-d5d6bb4hg0e473f61pkg-a.frankfurt-postgres.render.com";
    private $db_name = "telegram-password.db";
    private $username = "password_user";
    private $password = "maxkW80zJSKEGz1wr7N8B4Mbk0RYcGT";
    public $conn;

    public function getConnection() {
        $this->conn = null;
        try {
            $this->conn = new PDO(
                "pgsql:host=" . $this->host . ";port=5432;dbname=" . $this->db_name,
                $this->username,
                $this->password
            );
            $this->conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        } catch(PDOException $exception) {
            echo "Connection error: " . $exception->getMessage();
        }
        return $this->conn;
    }
}
