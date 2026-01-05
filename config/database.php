<?php
class Database {
    private $host = "dpg-d5d6bb4hg0e473f61pkg-a.frankfurt-postgres.render.com";
    private $port = "5432";
    private $db_name = "telegram-password.db";
    private $username = "password_user";
    private $password = "maxkW80zJSKEGz1wr7N8B4Mbk0RYcGT";
    public $conn;

    public function getConnection() {
        $this->conn = null;
        try {
            $this->conn = new PDO(
                "pgsql:host=" . $this->host . 
                ";port=" . $this->port . 
                ";dbname=" . $this->db_name,
                $this->username,
                $this->password,
                array(
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_PERSISTENT => false,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
                )
            );
        } catch(PDOException $exception) {
            echo "Connection error: " . $exception->getMessage();
            error_log("Database connection error: " . $exception->getMessage());
        }
        return $this->conn;
    }
}
?>
