-- ignored ; ' quote
insert into users values ('semi;--it''s', 7); -- trailing comment
-- SELECT from nowhere
select age from users where name = 'semi;--it''s';
