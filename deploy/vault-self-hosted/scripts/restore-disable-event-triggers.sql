do $$
declare
  event_trigger_name text;
begin
  for event_trigger_name in
    select evtname from pg_event_trigger
  loop
    execute format('alter event trigger %I disable', event_trigger_name);
  end loop;
end;
$$;
