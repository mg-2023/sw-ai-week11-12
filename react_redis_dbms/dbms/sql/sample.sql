-- 미니 DBMS 예제: node cli.js sql/sample.sql
-- 테이블(users, products)은 data/schema.json 에 이미 정의돼 있다. id 는 자동으로 부여된다.

INSERT INTO users (name, age, city) VALUES ('김철수', 23, '서울');
INSERT INTO users (name, age, city) VALUES ('이영희', 31, '부산'), ('박민수', 27, '서울'), ('최지우', 45, '대전');
INSERT INTO users (name) VALUES ('나이를 모르는 사람');

INSERT INTO products VALUES ('키보드', 39000.5, 12), ('마우스', 15000, 0);

-- 전체 조회
SELECT * FROM users;

-- id 로 찾기: B+ 트리 인덱스를 쓴다
SELECT * FROM users WHERE id = 2;

-- id 범위: B+ 트리의 리프를 옆으로 따라간다
SELECT id, name FROM users WHERE id >= 2 AND id <= 4;

-- 다른 컬럼으로 찾기: 파일 전체를 읽는다 (선형 탐색)
SELECT name, age FROM users WHERE city = '서울' ORDER BY age DESC;

SELECT COUNT(*) FROM users WHERE age IS NULL;
SELECT name, price FROM products WHERE stock > 0;
