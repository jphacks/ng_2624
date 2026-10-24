-- Run these on demo.sqlite (SQLite only)
select name,role from users;
select u.display_name,c.kind,m.sender,m.content from messages m join conversations c on c.id=m.conversation_id join users u on u.id=c.user_id order by u.role,m.created_at;
select p.name,p.price_jpy,p.product_url,g.size,g.required_points,g.status from goals g join products p on p.id=g.product_id;
select p.id,p.version,a.user_id,a.decision from proposals p join proposal_approvals a on a.proposal_id=p.id;
select u.display_name,sum(t.delta_points) as balance from point_transactions t join users u on u.id=t.child_id group by u.id;
