from django.http import JsonResponse
from .models import Area, Habit, Plan

def index(request):
    return JsonResponse({"message": "Hello from Django!"})

def plan(request):
    plans = Plan.objects.prefetch_related(
        "habitplan_set__habit__habitchain_set__chain__habitchain_set__habit"
    )
    data = []
    for plan in plans:
        # print(plan)
        # print()
        # get all habits at this time
        habits = []
        habit_plans = plan.habitplan_set.all()
        # print(habit_plans)
        # print()
        for habit_plan in habit_plans:
            # check if it has other habits in chain
            habit = habit_plan.habit
            # print(habit)
            # print()
            habit_chain = habit.habitchain_set
            habit_chain = habit_chain.first() # first bc theres only 1
    
            if habit_chain:   # check if it relationship exists
                if habit_chain.order > 1:
                    continue
                chain = habit_chain.chain
                # get habits in this chain
                chain_habits = chain.habitchain_set.all()
                # print(chain_habits)
                # prep each habit
                for chain_habit in chain_habits:
                
                    habitt = chain_habit.habit
                    habits.append({
                        "name": habitt.name,
                        "id": habitt.id,
                        "chain": habit_chain.id,
                        "order": chain_habit.order
                    })
            else:
                habits.append({
                    "name": habit.name,     # note: the outer habit, not habitt
                    "id": habit.id,
                    "chain": None
                })

                
        # add habits to plan
        plan_data = {
            "id": plan.id,
            "time": plan.start_time,
            "habits": habits
        }
        # print(plan_data)
        # print()
        data.append(plan_data)


    missed_habits = {
        "id": None,
        "time": None, 
        "habits": [{"name": h.name, "id": h.id} for h in Habit.objects.filter(habitplan__isnull=True)]

    }
    # habits with no plans
    data.append(missed_habits)

    return JsonResponse(data, safe=False)

def areas(request):
    areas = Area.objects.all().order_by('name')
    data = list(areas.values('id', 'name'))
    return JsonResponse(data, safe=False)

def area(request, area_id):
    area = Area.objects.get(id=area_id)
    habits = area.habit_set.order_by('-date_added')
    data = list(habits.values('id', 'name', 'notes'))
    return JsonResponse({"area": area.name, "habits": data})
