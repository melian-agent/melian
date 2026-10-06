export function managerName(user) {
  if (!user.manager) return "none";

  return user.manager.name;
}
