VALID_STATUSES = {"created", "pending", "completed", "not_completed"}


def dependency_blocker(ticket, tickets, columns, target_status):
    """Return the unfinished ticket that blocks moving `ticket` to `target_status`, or None."""
    if target_status not in ("pending", "completed"):
        return None
    dep_id = ticket.get("dependency", 0)
    if not dep_id or columns.get(str(dep_id)) == "completed":
        return None
    return next((t for t in tickets if t["id"] == dep_id), None)


def validate_tickets(tickets):
    """Return an error message if the ticket list is invalid, else None."""
    ids = [t["id"] for t in tickets]
    if len(set(ids)) != len(ids):
        return "Ticket IDs must be unique"
    for t in tickets:
        if not t["task"].strip():
            return f"Ticket #{t['id']} needs a task description"
        dep = t["dependency"]
        if dep and dep not in ids:
            return f"Ticket #{t['id']} depends on #{dep}, which doesn't exist"

    # Each ticket has at most one dependency, so follow each chain looking for a loop
    dep_of = {t["id"]: t["dependency"] for t in tickets}
    for start in dep_of:
        seen, cur = set(), start
        while cur and cur not in seen:
            seen.add(cur)
            cur = dep_of.get(cur, 0)
        if cur:
            return f"Ticket #{start} is part of a dependency loop"
    return None
