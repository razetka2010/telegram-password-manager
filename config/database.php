<?php
class Database {
    private $host = "dpg-d5dd0b4hg0os73f6lpkg-a";
    private $db_name = "telegram-password-db";
    private $username = "password_user";
    private $password = "mAzbKN3QzJSkEGziwr7WSB4NbkDRYcCT";
    public $conn;

    public function getConnection() {
        $this->conn = null;
        try {
            $this->conn = new PDO(
                "mysql:host=" . $this->host . ";dbname=" . $this->db_name,
                $this->username,
                $this->password
            );
            $this->conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->conn->exec("set names utf8");
        } catch(PDOException $exception) {
            echo "Connection error: " . $exception->getMessage();
        }
        return $this->conn;
    }
}
?>
